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
  aliveGroups?: number[];
  startedAt?: Record<number, number>;
  maxRunMs?: number;
  dryRun?: boolean;
  killOrphans?: boolean;
}) {
  const records = new Map((opts.records ?? []).map((r) => [r.name, structuredClone(r)]));
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const alive = new Set(opts.alivePids ?? []);
  const aliveGroups = new Set(opts.aliveGroups ?? []);
  const writes: LaneRecord[] = [];
  const kills: Array<{ pgid: number; signal: string }> = [];
  const sleeps: number[] = [];
  const deps = {
    repoRoot: "/repo",
    dryRun: opts.dryRun,
    killOrphans: opts.killOrphans,
    now: () => opts.now ?? 100_000,
    isAlive: (pid: number) => alive.has(pid),
    groupAlive: (pgid: number) => aliveGroups.has(pgid),
    startedAtOf: (pid: number) => opts.startedAt?.[pid],
    maxRunMs: opts.maxRunMs,
    killGroup: (pgid: number, signal: string) => {
      kills.push({ pgid, signal });
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    graceMs: 5_000,
    listWorktrees: async () => new Map(worktrees),
    readLaneNames: () => [...records.keys()],
    readRecord: (_root: string, name: string) => records.get(name) ?? null,
    writeRecord: (_root: string, record: LaneRecord) => {
      writes.push(structuredClone(record));
      records.set(record.name, structuredClone(record));
    },
  };
  return { deps, records, writes, kills, sleeps, alive };
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

/** A timed-out running lane: supervisor (pid 4321) alive but over the injected budget. */
function timedOutSetup(over: Partial<Parameters<typeof harness>[0]> = {}) {
  return harness({
    records: [runningRecord({ startedAt: 0 })],
    worktrees: { "agetree/feature-x": "/wt/feature-x" },
    alivePids: [4321],
    maxRunMs: 50_000, // now (100_000) - startedAt (0) > 50_000 ⇒ timed-out
    ...over,
  });
}

describe("gc kill", () => {
  it("timed-out: SIGTERM the group, then SIGKILL after the grace, then persist timed-out", async () => {
    const { deps, kills, sleeps, writes } = timedOutSetup();

    const summary = await gc(deps);

    // Group signalled via pgid == supervisorPid, escalating after one grace sleep.
    expect(kills).toEqual([
      { pgid: 4321, signal: "SIGTERM" },
      { pgid: 4321, signal: "SIGKILL" },
    ]);
    expect(sleeps).toEqual([5_000]);
    expect(summary.killed).toEqual([
      { name: "feature-x", pgid: 4321, signals: ["SIGTERM", "SIGKILL"] },
    ]);
    // Kill happens before the guarded heal; timed-out is then persisted.
    expect(writes[0]!.status).toBe<Status>("timed-out");
    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "timed-out" }]);
  });

  it("timed-out: no SIGKILL when the group dies within the grace", async () => {
    const { deps, kills, alive } = timedOutSetup();
    // The group exits on SIGTERM: drop it from the live set when TERM is sent.
    deps.killGroup = (pgid: number, signal: string) => {
      kills.push({ pgid, signal });
      if (signal === "SIGTERM") alive.delete(pgid);
    };

    const summary = await gc(deps);

    expect(kills).toEqual([{ pgid: 4321, signal: "SIGTERM" }]);
    expect(summary.killed).toEqual([{ name: "feature-x", pgid: 4321, signals: ["SIGTERM"] }]);
  });

  it("pid-recycled (startedAt mismatch) is classified stale by reconcile → no kill", async () => {
    const { deps, kills, writes } = timedOutSetup({
      startedAt: { 4321: 999_999 }, // live pid's start time ≠ record's ⇒ recycle
    });

    const summary = await gc(deps);

    expect(kills).toEqual([]);
    expect(writes[0]!.status).toBe<Status>("stale");
    expect(summary.killed).toEqual([]);
  });

  it("timed-out but the supervisor finished before the kill guard → no kill, heal discarded", async () => {
    const { deps, records, kills, writes } = timedOutSetup();
    // reconcile computes timed-out (first read), but the guard re-read finds the
    // supervisor's own terminal record.
    let reads = 0;
    const supervisorDone = runningRecord({ status: "done", endedAt: 90_000, startedAt: 0 });
    deps.readRecord = (_root: string, name: string) => {
      reads += 1;
      if (name === "feature-x" && reads >= 2) return supervisorDone;
      return records.get(name) ?? null;
    };

    const summary = await gc(deps);

    expect(kills).toEqual([]);
    expect(writes).toEqual([]);
    expect(summary.skipped).toContainEqual({
      name: "feature-x",
      reason: "supervisor finished before kill",
    });
  });

  it("stale: no kill by default", async () => {
    const { deps, kills } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [], // supervisor dead ⇒ stale
    });

    const summary = await gc(deps);

    expect(kills).toEqual([]);
    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "stale" }]);
  });

  it("stale + --kill-orphans + group still alive → best-effort group kill", async () => {
    const { deps, kills } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [], // leader dead
      aliveGroups: [4321], // but a reparented child keeps the group alive
      killOrphans: true,
    });

    const summary = await gc(deps);

    expect(kills[0]).toEqual({ pgid: 4321, signal: "SIGTERM" });
    expect(summary.killed[0]!.name).toBe("feature-x");
    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "stale" }]);
  });

  it("stale + --kill-orphans but the group is gone → no kill", async () => {
    const { deps, kills } = harness({
      records: [runningRecord()],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
      alivePids: [],
      aliveGroups: [], // group already reaped
      killOrphans: true,
    });

    const summary = await gc(deps);

    expect(kills).toEqual([]);
    expect(summary.killed).toEqual([]);
  });

  it("a kill that throws is reported but does not fail the run; other lanes still processed", async () => {
    const { deps, kills, writes } = harness({
      records: [
        runningRecord({ name: "a", branch: "agetree/a", supervisorPid: 100, startedAt: 0 }),
        runningRecord({ name: "b", branch: "agetree/b", supervisorPid: 200, startedAt: 0 }),
      ],
      worktrees: { "agetree/a": "/wt/a", "agetree/b": "/wt/b" },
      alivePids: [100, 200],
      maxRunMs: 50_000, // both timed-out
    });
    deps.killGroup = (pgid: number, signal: string) => {
      if (pgid === 100) throw new Error("EPERM");
      kills.push({ pgid, signal });
    };

    const summary = await gc(deps);

    // Lane a's kill failed (reported, non-fatal); lane b was killed normally.
    expect(summary.skipped).toContainEqual({ name: "a", reason: "kill failed: EPERM" });
    expect(kills.map((k) => k.pgid)).toEqual([200, 200]);
    // Both lanes still healed to timed-out — a failed kill doesn't block the heal.
    expect(summary.healed).toEqual([
      { name: "a", from: "running", to: "timed-out" },
      { name: "b", from: "running", to: "timed-out" },
    ]);
    expect(writes.map((w) => w.name).sort()).toEqual(["a", "b"]);
  });

  it("--dry-run reports the intended kill but signals nothing", async () => {
    const { deps, kills, sleeps, writes } = timedOutSetup({ dryRun: true });

    const summary = await gc(deps);

    expect(kills).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(writes).toEqual([]);
    expect(summary.killed).toEqual([
      { name: "feature-x", pgid: 4321, signals: ["SIGTERM", "SIGKILL"] },
    ]);
    expect(summary.healed).toEqual([{ name: "feature-x", from: "running", to: "timed-out" }]);
  });
});
