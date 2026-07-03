import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import type { LaneRecord } from "./lane-state.ts";
import { runRm } from "./rm.ts";

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

/**
 * Build runRm deps from a record set + a worktree map, exposing spies for the
 * engine and the artifact-delete primitive.
 */
function harness(opts: {
  records?: LaneRecord[];
  worktrees?: Record<string, string>;
  removeExit?: number;
  deleteThrows?: boolean;
}) {
  const records = new Map((opts.records ?? []).map((r) => [r.name, r]));
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const remove = vi.fn(async () => opts.removeExit ?? 0);
  const deleteArtifacts = vi.fn((_root: string, _name: string) => {
    if (opts.deleteThrows) throw new Error("EACCES");
  });
  const engine: Engine = {
    ensureWorktree: async () => ({ branch: "b", path: "/p" }),
    runInteractive: async () => 0,
    merge: async () => 0,
    remove,
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
  return { deps, remove, deleteArtifacts, err };
}

describe("runRm", () => {
  it("normalizes a lane name to its branch before calling engine.remove, and forwards --force", async () => {
    const { deps, remove } = harness({
      records: [laneRecord("feature-x", "agetree/feature-x")],
    });
    const { exitCode } = await runRm({ ...deps, identifier: "feature-x", force: true });
    expect(exitCode).toBe(0);
    expect(remove).toHaveBeenCalledWith("agetree/feature-x", { force: true });
  });

  it("exit 0 + record exists + worktree gone → deletes the lane's artifacts", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feature-x", "agetree/feature-x")],
      worktrees: {}, // branch's worktree is gone
    });
    await runRm({ ...deps, identifier: "feature-x" });
    expect(deleteArtifacts).toHaveBeenCalledWith("/repo", "feature-x");
  });

  it("exit 0 + bare branch (no record) → nothing to clean up", async () => {
    const { deps, remove, deleteArtifacts } = harness({ records: [] });
    const { exitCode } = await runRm({ ...deps, identifier: "some-branch" });
    expect(exitCode).toBe(0);
    expect(remove).toHaveBeenCalledWith("some-branch", { force: undefined });
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("exit 0 + record exists but worktree STILL present → does NOT delete (never demote a live lane)", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feature-x", "agetree/feature-x")],
      worktrees: { "agetree/feature-x": "/wt/feature-x" },
    });
    await runRm({ ...deps, identifier: "feature-x" });
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("engine failure (non-zero) → nothing deleted, exit code preserved", async () => {
    const { deps, deleteArtifacts } = harness({
      records: [laneRecord("feature-x", "agetree/feature-x")],
      worktrees: {},
      removeExit: 1,
    });
    const { exitCode } = await runRm({ ...deps, identifier: "feature-x" });
    expect(exitCode).toBe(1);
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("a delete failure is reported but does not fail the command (engine exit preserved)", async () => {
    const { deps, err } = harness({
      records: [laneRecord("feature-x", "agetree/feature-x")],
      worktrees: {},
      deleteThrows: true,
    });
    const { exitCode } = await runRm({ ...deps, identifier: "feature-x" });
    expect(exitCode).toBe(0);
    expect(err.text).toMatch(/could not remove lane artifacts for 'feature-x'/);
  });
});
