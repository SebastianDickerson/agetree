import { describe, expect, it } from "vitest";
import type { LaneRecord, Status } from "./lane-state.ts";
import { listLanes } from "./list.ts";

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

/**
 * Build injected deps for listLanes: a record set keyed by name, a worktree
 * map (branch → path), and deterministic now/isAlive.
 */
function harness(opts: {
  records?: LaneRecord[];
  worktrees?: Record<string, string>;
  now?: number;
  alivePids?: number[];
}) {
  const records = new Map((opts.records ?? []).map((r) => [r.name, r]));
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const alive = new Set(opts.alivePids ?? []);
  return {
    repoRoot: "/repo",
    all: true,
    now: () => opts.now ?? 100_000,
    isAlive: (pid: number) => alive.has(pid),
    listWorktrees: async () => new Map(worktrees),
    readLaneNames: () => [...records.keys()],
    readRecord: (_root: string, name: string) => records.get(name) ?? null,
  };
}

function laneRows(views: Awaited<ReturnType<typeof listLanes>>) {
  return views.filter((v): v is Extract<typeof v, { kind: "lane" }> => v.kind === "lane");
}

describe("listLanes reconciliation", () => {
  it("reclassifies a running lane whose supervisor pid is dead as stale", async () => {
    const views = await listLanes(
      harness({
        records: [runningRecord()],
        worktrees: { "agetree/feature-x": "/wt/feature-x" },
        alivePids: [], // pid 4321 is dead
      }),
    );

    expect(laneRows(views)).toHaveLength(1);
    const row = laneRows(views)[0]!;
    expect(row.record.status).toBe<Status>("stale");
    expect(row.orphaned).toBe(false);
  });

  it("marks a terminal lane whose worktree is gone as orphaned", async () => {
    const views = await listLanes(
      harness({
        records: [runningRecord({ status: "done", endedAt: 22_400, payload: null })],
        worktrees: {}, // worktree removed
      }),
    );

    const row = laneRows(views)[0]!;
    expect(row.record.status).toBe<Status>("done");
    expect(row.orphaned).toBe(true);
  });

  it("keeps a healthy running lane (live pid, worktree present) as running", async () => {
    const views = await listLanes(
      harness({
        records: [runningRecord()],
        worktrees: { "agetree/feature-x": "/wt/feature-x" },
        alivePids: [4321], // supervisor still alive
      }),
    );

    const row = laneRows(views)[0]!;
    expect(row.record.status).toBe<Status>("running");
    expect(row.orphaned).toBe(false);
  });
});

describe("listLanes interactive worktrees", () => {
  it("surfaces a worktree with no lane record as an interactive row", async () => {
    const views = await listLanes(
      harness({
        records: [],
        worktrees: { "ui-polish": "/wt/ui-polish" },
      }),
    );

    expect(views).toEqual([
      { kind: "interactive", name: "ui-polish", branch: "ui-polish", path: "/wt/ui-polish" },
    ]);
  });

  it("does not treat a worktree that already has a lane record as interactive", async () => {
    const views = await listLanes(
      harness({
        records: [runningRecord()],
        worktrees: { "agetree/feature-x": "/wt/feature-x" },
        alivePids: [4321],
      }),
    );

    expect(views).toHaveLength(1);
    expect(views[0]!.kind).toBe("lane");
  });

  it("excludes interactive worktrees when all=false (lane-only view)", async () => {
    const views = await listLanes({
      ...harness({
        records: [runningRecord()],
        worktrees: { "agetree/feature-x": "/wt/feature-x", "ui-polish": "/wt/ui-polish" },
        alivePids: [4321],
      }),
      all: false,
    });

    expect(views).toHaveLength(1);
    expect(views.every((v) => v.kind === "lane")).toBe(true);
  });
});

describe("listLanes ordering", () => {
  it("returns a stable, deterministic order (by branch) across lanes and interactive worktrees", async () => {
    const views = await listLanes(
      harness({
        records: [
          runningRecord({ name: "zeta", branch: "agetree/zeta" }),
          runningRecord({ name: "alpha", branch: "agetree/alpha" }),
        ],
        worktrees: {
          "agetree/zeta": "/wt/zeta",
          "agetree/alpha": "/wt/alpha",
          "mid-interactive": "/wt/mid",
        },
        alivePids: [4321],
      }),
    );

    expect(views.map((v) => (v.kind === "lane" ? v.record.branch : v.branch))).toEqual([
      "agetree/alpha",
      "agetree/zeta",
      "mid-interactive",
    ]);
  });
});
