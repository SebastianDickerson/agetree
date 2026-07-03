import { describe, expect, it, vi } from "vitest";
import type { LaneRecord, Status } from "./lane-state.ts";
import { gc } from "./gc.ts";

/** A running lane record with sensible defaults; override per test. */
function runningRecord(over: Partial<LaneRecord> = {}): LaneRecord {
  return {
    name: "feature-x",
    branch: "agetree/feature-x",
    adapter: "claude",
    prompt: "do x",
    supervisorPid: 4321,
    supervisorStartedAt: 1_000,
    status: "running",
    startedAt: 10_000,
    logPath: ".agetree/logs/feature-x.log",
    payload: null,
    ...over,
  };
}

function terminalRecord(over: Partial<LaneRecord> = {}): LaneRecord {
  return runningRecord({
    status: "done",
    endedAt: 22_400,
    payload: { exitCode: 0, isError: false, finalMessage: "done x" },
    ...over,
  });
}

/**
 * Build gc deps from a record set keyed by name plus a worktree map. `readRecord`
 * always reflects the current map, so a test can mutate a record mid-run (e.g. to
 * simulate the supervisor winning the resurrection race) and later reads see it.
 */
function harness(opts: {
  records?: LaneRecord[];
  worktrees?: Record<string, string>;
  now?: number;
  alivePids?: number[];
  startedAt?: Record<number, number>;
  maxRunMs?: number;
  dryRun?: boolean;
}) {
  const records = new Map((opts.records ?? []).map((r) => [r.name, structuredClone(r)]));
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const alive = new Set(opts.alivePids ?? []);
  const writes: LaneRecord[] = [];
  const deps = {
    repoRoot: "/repo",
    dryRun: opts.dryRun,
    now: () => opts.now ?? 100_000,
    isAlive: (pid: number) => alive.has(pid),
    startedAtOf: (pid: number) => opts.startedAt?.[pid],
    maxRunMs: opts.maxRunMs,
    listWorktrees: async () => new Map(worktrees),
    readLaneNames: () => [...records.keys()],
    readRecord: (_root: string, name: string) => records.get(name) ?? null,
    writeRecord: (_root: string, record: LaneRecord) => {
      writes.push(structuredClone(record));
      records.set(record.name, structuredClone(record));
    },
  };
  return { deps, records, writes };
}

describe("gc persist-heal", () => {
  it("persists a dead-pid running lane as stale (guarded RMW)", async () => {
    const { deps, writes } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [], // pid 4321 dead
    });

    const summary = await gc(deps);

    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "stale" }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.status).toBe<Status>("stale");
    expect(writes[0]!.endedAt).toBe(100_000);
    expect(summary.skipped).toEqual([]);
  });

  it("persists an over-budget running lane as timed-out", async () => {
    const { deps, writes } = harness({
      records: [runningRecord({ startedAt: 0 })],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [4321], // supervisor alive but over budget
      maxRunMs: 50_000, // now (100_000) - startedAt (0) > 50_000
    });

    const summary = await gc(deps);

    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "timed-out" }]);
    expect(writes[0]!.status).toBe<Status>("timed-out");
  });

  it("never rewrites a healthy running lane", async () => {
    const { deps, writes } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [4321], // supervisor alive, no budget
    });

    const summary = await gc(deps);

    expect(summary.healed).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("never rewrites an already-terminal record", async () => {
    const { deps, writes } = harness({
      records: [terminalRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
    });

    const summary = await gc(deps);

    expect(summary.healed).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("resurrection race: re-read shows the supervisor's terminal record → heal discarded, record untouched", async () => {
    const { deps, records, writes } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [], // reconcile computes a heal to stale
    });

    // Between reconcile and the guard re-read, the supervisor wins: it writes a
    // terminal `done` record. Model that by flipping the stored record on the
    // second read (the guard re-read).
    let reads = 0;
    const supervisorTerminal = terminalRecord();
    deps.readRecord = (_root: string, name: string) => {
      reads += 1;
      if (name === "feature-x" && reads >= 2) return supervisorTerminal;
      return records.get(name) ?? null;
    };

    const summary = await gc(deps);

    expect(summary.healed).toEqual([]);
    expect(writes).toEqual([]); // supervisor's record kept, gc's heal discarded
    expect(summary.skipped).toEqual([
      { name: "feature-x", reason: "supervisor recorded a terminal status first" },
    ]);
  });

  it("pid/startedAt changed on the re-read → heal discarded", async () => {
    const { deps, records, writes } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [],
    });

    // A fresh supervisor claimed the lane (new pid + start time) still `running`.
    let reads = 0;
    deps.readRecord = (_root: string, name: string) => {
      reads += 1;
      if (name === "feature-x" && reads >= 2) {
        return runningRecord({ supervisorPid: 9999, supervisorStartedAt: 2_000 });
      }
      return records.get(name) ?? null;
    };

    const summary = await gc(deps);

    expect(summary.healed).toEqual([]);
    expect(writes).toEqual([]);
    expect(summary.skipped).toEqual([
      { name: "feature-x", reason: "supervisor pid/start changed before heal" },
    ]);
  });

  it("--dry-run computes the heal but writes nothing", async () => {
    const writeSpy = vi.fn();
    const { deps } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [],
      dryRun: true,
    });
    deps.writeRecord = writeSpy;

    const summary = await gc(deps);

    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "stale" }]);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
