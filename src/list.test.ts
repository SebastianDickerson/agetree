import { describe, expect, it } from "vitest";
import type { LaneRecord, Status } from "./lane-state.ts";
import { Writable } from "node:stream";
import {
  formatLanesJson,
  formatLanesTable,
  listLanes,
  runList,
  type LaneRow,
} from "./list.ts";

function collector(): Writable & { text: string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk;
      cb();
    },
  }) as Writable & { text: string };
  Object.defineProperty(stream, "text", { get: () => text });
  return stream;
}

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

function doneRow(over: Partial<LaneRecord> = {}): LaneRow {
  return {
    kind: "lane",
    orphaned: false,
    record: {
      name: "feature-x",
      branch: "agetree/feature-x",
      adapter: "claude",
      prompt: "do x",
      supervisorPid: 4321,
      supervisorStartedAt: 1_000,
      status: "done",
      startedAt: 10_000,
      endedAt: 22_400,
      logPath: ".agetree/logs/feature-x.log",
      payload: {
        exitCode: 0,
        isError: false,
        finalMessage: "done x",
        commit: { outcome: "committed", sha: "d4e5f6a", baseSha: "a1b2c3d" },
        filesChanged: { count: 3, files: ["src/a.ts"], truncated: false },
      },
      ...over,
    },
  };
}

describe("formatLanesJson", () => {
  it("emits a newline-terminated JSON array of public records with supervisor plumbing stripped", () => {
    const out = formatLanesJson([doneRow()]);

    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd().split("\n")).toHaveLength(1); // single line: one array

    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]).toMatchObject({
      name: "feature-x",
      branch: "agetree/feature-x",
      status: "done",
      adapter: "claude",
      orphaned: false,
    });
    expect(arr[0]).not.toHaveProperty("supervisorPid");
    expect(arr[0]).not.toHaveProperty("supervisorStartedAt");
  });

  it("carries the derived orphaned flag into the public record", () => {
    const arr = JSON.parse(formatLanesJson([{ ...doneRow(), orphaned: true }]));
    expect(arr[0].orphaned).toBe(true);
  });

  it("emits interactive worktrees as a minimal shape marked interactive", () => {
    const arr = JSON.parse(
      formatLanesJson([
        { kind: "interactive", name: "ui-polish", branch: "ui-polish", path: "/wt/ui-polish" },
      ]),
    );
    expect(arr[0]).toEqual({ name: "ui-polish", branch: "ui-polish", status: "interactive" });
  });

  it("emits an empty array (still newline-terminated) when there are no lanes", () => {
    expect(formatLanesJson([])).toBe("[]\n");
  });
});

describe("formatLanesTable", () => {
  it("projects a done lane: glyph, status, name, branch, adapter and duration", () => {
    const out = formatLanesTable([doneRow()]);
    expect(out).toContain("✓");
    expect(out).toContain("done");
    expect(out).toContain("feature-x");
    expect(out).toContain("agetree/feature-x");
    expect(out).toContain("claude");
    expect(out).toContain("12.4s"); // 22400 - 10000 = 12400ms
  });

  it("shows elapsed age for a running lane using the injected now", () => {
    const running = { ...doneRow({ status: "running", endedAt: undefined, payload: null }) };
    const out = formatLanesTable([running], { now: () => 100_000 }); // 100000 - 10000 = 90000ms
    expect(out).toContain("…");
    expect(out).toContain("1m30s");
  });

  it("notes an orphaned lane", () => {
    const out = formatLanesTable([{ ...doneRow(), orphaned: true }]);
    expect(out).toContain("orphaned");
  });

  it("marks an interactive worktree with an interactive note and no adapter/duration", () => {
    const out = formatLanesTable([
      { kind: "interactive", name: "ui-polish", branch: "ui-polish", path: "/wt/ui" },
    ]);
    expect(out).toContain("ui-polish");
    expect(out).toContain("interactive");
  });

  it("prints a clear message when there are no lanes", () => {
    expect(formatLanesTable([])).toBe("no lanes\n");
  });

  it("humanizes a multi-hour duration compactly", () => {
    // startedAt 0, endedAt 3_720_000ms = 62 minutes → 1h02m
    const out = formatLanesTable([doneRow({ startedAt: 0, endedAt: 3_720_000 })]);
    expect(out).toContain("1h02m");
  });
});

describe("runList", () => {
  const deps = {
    repoRoot: "/repo",
    now: () => 100_000,
    isAlive: () => true,
    listWorktrees: async () => new Map([["agetree/feature-x", "/wt/feature-x"]]),
    readLaneNames: () => ["feature-x"],
    readRecord: () => doneRow().record,
  };

  it("--json writes only the JSON array to stdout and exits 0", async () => {
    const out = collector();
    const err = collector();
    const res = await runList({ ...deps, json: true, out, err });

    expect(res.exitCode).toBe(0);
    expect(err.text).toBe("");
    const arr = JSON.parse(out.text);
    expect(arr[0]).toMatchObject({ name: "feature-x", status: "done" });
    expect(arr[0]).not.toHaveProperty("supervisorPid");
  });

  it("human mode writes the table to stdout and exits 0", async () => {
    const out = collector();
    const err = collector();
    const res = await runList({ ...deps, json: false, out, err });

    expect(res.exitCode).toBe(0);
    expect(out.text).toContain("feature-x");
    expect(out.text).toContain("agetree/feature-x");
  });

  it("exits 2 with empty stdout and a stderr diagnostic on an operational error", async () => {
    const out = collector();
    const err = collector();
    const res = await runList({
      ...deps,
      json: true,
      listWorktrees: async () => {
        throw new Error("git boom");
      },
      out,
      err,
    });

    expect(res.exitCode).toBe(2);
    expect(out.text).toBe("");
    expect(err.text).toMatch(/git boom/);
  });
});
