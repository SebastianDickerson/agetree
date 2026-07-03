import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import type { LaneRecord } from "./lane-state.ts";
import { runMerge } from "./merge.ts";

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

function laneRecord(name: string, branch: string): LaneRecord {
  return {
    name,
    branch,
    adapter: "fake",
    prompt: "p",
    supervisorPid: 1,
    supervisorStartedAt: 1,
    status: "done",
    startedAt: 1,
    endedAt: 2,
    logPath: `.agetree/logs/${name}.log`,
    payload: null,
  };
}

function harness(opts: {
  records?: LaneRecord[];
  worktrees?: Record<string, string>;
  mergeExit?: number;
}) {
  const records = new Map((opts.records ?? []).map((r) => [r.name, r]));
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const merge = vi.fn(async () => opts.mergeExit ?? 0);
  const deleteArtifacts = vi.fn();
  const engine: Engine = {
    ensureWorktree: async () => ({ branch: "b", path: "/p" }),
    runInteractive: async () => 0,
    merge,
    remove: async () => 0,
  };
  const err = collector();
  const deps = {
    repoRoot: "/repo",
    engine,
    err,
    listWorktrees: async () => new Map(worktrees),
    readLaneNames: () => [...records.keys()],
    readRecord: (_root: string, name: string) => records.get(name) ?? null,
    deleteArtifacts,
  };
  return { deps, merge, deleteArtifacts, err };
}

describe("runMerge", () => {
  it("normalizes target + branches to their branches and forwards --all/--rm to engine.merge", async () => {
    const { deps, merge } = harness({
      records: [laneRecord("feat-a", "agetree/feat-a")],
      worktrees: { "agetree/feat-a": "/wt/a" },
    });
    // target "main" is a bare branch; "feat-a" resolves to its lane branch.
    const { exitCode } = await runMerge({
      ...deps,
      target: "main",
      branches: ["feat-a"],
      all: false,
      rm: true,
    });
    expect(exitCode).toBe(0);
    expect(merge).toHaveBeenCalledWith("main", ["agetree/feat-a"], { all: false, rm: true });
  });

  it("exit 0 + --rm + worktree gone → prunes the merged lane's artifacts", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feat-a", "agetree/feat-a")],
      worktrees: {}, // --rm removed the worktree
    });
    await runMerge({ ...deps, target: "main", branches: ["feat-a"], rm: true });
    expect(deleteArtifacts).toHaveBeenCalledWith("/repo", "feat-a");
  });

  it("exit 0 + --rm + worktree STILL present → does NOT prune", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feat-a", "agetree/feat-a")],
      worktrees: { "agetree/feat-a": "/wt/a" },
    });
    await runMerge({ ...deps, target: "main", branches: ["feat-a"], rm: true });
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("exit 0 WITHOUT --rm → prunes nothing (worktrees are left in place)", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feat-a", "agetree/feat-a")],
      worktrees: {},
    });
    await runMerge({ ...deps, target: "main", branches: ["feat-a"], rm: false });
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("engine failure (conflict) → nothing pruned, exit code preserved", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feat-a", "agetree/feat-a")],
      worktrees: {},
      mergeExit: 1,
    });
    const { exitCode } = await runMerge({ ...deps, target: "main", branches: ["feat-a"], rm: true });
    expect(exitCode).toBe(1);
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("--all: targets every record and prunes only those whose worktree vanished", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [
        laneRecord("feat-a", "agetree/feat-a"), // worktree gone → pruned
        laneRecord("feat-b", "agetree/feat-b"), // worktree survives → kept
      ],
      worktrees: { "agetree/feat-b": "/wt/b" },
    });
    // --all ignores the explicit branch list; cleanup considers all records.
    await runMerge({ ...deps, target: "main", branches: [], all: true, rm: true });
    expect(deleteArtifacts).toHaveBeenCalledWith("/repo", "feat-a");
    expect(deleteArtifacts).not.toHaveBeenCalledWith("/repo", "feat-b");
  });
});
