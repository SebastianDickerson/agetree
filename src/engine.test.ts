import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createEngine, type EngineRunner, type WorktreeReader } from "./engine.ts";

type Call = { cmd: string; args: string[] };

/**
 * Build an engine backed by spies:
 *  - `run` records every engine invocation and returns `exitCode`. When the
 *    engine is asked to `new <branch>`, it adds that branch to `worktrees`
 *    (modeling the Bash engine creating a worktree).
 *  - `listWorktrees` reads the shared `worktrees` map, so a re-read after
 *    `new` sees the freshly-created path.
 */
function harness(opts: { worktrees?: Record<string, string>; exitCode?: number } = {}) {
  const calls: Call[] = [];
  const worktrees = new Map(Object.entries(opts.worktrees ?? {}));
  const exitCode = opts.exitCode ?? 0;

  const run: EngineRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "new") {
      const branch = args[1]!;
      worktrees.set(branch, `/tmp/worktrees/${branch}`);
    }
    return exitCode;
  };

  const listWorktrees: WorktreeReader = async () => new Map(worktrees);

  const engine = createEngine({
    enginePath: "/repo/agent-worktree.sh",
    cwd: "/repo",
    run,
    listWorktrees,
  });

  return { engine, calls, worktrees };
}

describe("engine.ensureWorktree", () => {
  it("returns the existing worktree without invoking the engine", async () => {
    const { engine, calls } = harness({
      worktrees: { "feature-x": "/tmp/worktrees/feature-x" },
    });

    const result = await engine.ensureWorktree("feature-x");

    expect(result).toEqual({ branch: "feature-x", path: "/tmp/worktrees/feature-x" });
    expect(calls).toEqual([]);
  });

  it("creates a missing worktree via `new <branch>` then re-reads git for the path", async () => {
    const { engine, calls } = harness();

    const result = await engine.ensureWorktree("feature-y");

    expect(calls).toEqual([{ cmd: "/repo/agent-worktree.sh", args: ["new", "feature-y"] }]);
    expect(result).toEqual({ branch: "feature-y", path: "/tmp/worktrees/feature-y" });
  });

  it("passes the base branch through to `new <branch> <base>`", async () => {
    const { engine, calls } = harness();

    await engine.ensureWorktree("feature-z", "main");

    expect(calls).toEqual([
      { cmd: "/repo/agent-worktree.sh", args: ["new", "feature-z", "main"] },
    ]);
  });

  it("throws an operational error when no worktree exists after creation", async () => {
    // Runner that reports success but never actually creates the worktree.
    const run: EngineRunner = async () => 0;
    const listWorktrees: WorktreeReader = async () => new Map();
    const engine = createEngine({
      enginePath: "/repo/agent-worktree.sh",
      cwd: "/repo",
      run,
      listWorktrees,
    });

    await expect(engine.ensureWorktree("ghost")).rejects.toThrow(/no worktree/i);
  });
});

describe("engine delegation argv", () => {
  it("runInteractive delegates to `run <branch>` and returns its exit code", async () => {
    const { engine, calls } = harness({ exitCode: 3 });

    const code = await engine.runInteractive("ui-polish");

    expect(code).toBe(3);
    expect(calls).toEqual([{ cmd: "/repo/agent-worktree.sh", args: ["run", "ui-polish"] }]);
  });

  it("merge delegates to `merge <target> <branches...>` with flags", async () => {
    const { engine, calls } = harness();

    await engine.merge("main", ["a", "b"], { all: true, rm: true });

    expect(calls).toEqual([
      { cmd: "/repo/agent-worktree.sh", args: ["merge", "main", "a", "b", "--all", "--rm"] },
    ]);
  });

  it("merge omits flags when not requested", async () => {
    const { engine, calls } = harness();

    await engine.merge("main", ["a"]);

    expect(calls).toEqual([{ cmd: "/repo/agent-worktree.sh", args: ["merge", "main", "a"] }]);
  });

  it("remove delegates to `rm <branch>`", async () => {
    const { engine, calls } = harness();

    await engine.remove("old-lane");

    expect(calls).toEqual([{ cmd: "/repo/agent-worktree.sh", args: ["rm", "old-lane"] }]);
  });
});

describe("engine output redirection (headless path)", () => {
  it("routes engine stdout+stderr to the given sink instead of inheriting to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agetree-engine-"));
    const script = join(dir, "fake-engine.sh");
    writeFileSync(script, "#!/bin/sh\necho engine-stdout\necho engine-stderr >&2\nexit 7\n");
    chmodSync(script, 0o755);

    const sink = new PassThrough();
    let captured = "";
    sink.on("data", (d) => (captured += d));

    const engine = createEngine({
      enginePath: script,
      cwd: dir,
      redirectEngineOutput: sink,
    });

    const code = await engine.runInteractive("whatever");

    expect(code).toBe(7);
    expect(captured).toContain("engine-stdout");
    expect(captured).toContain("engine-stderr");
  });
});

describe("engine default runner", () => {
  it("fails fast when the engine script is missing or not executable", async () => {
    const engine = createEngine({
      enginePath: "/does/not/exist/agent-worktree.sh",
      cwd: "/tmp",
    });

    await expect(engine.runInteractive("whatever")).rejects.toThrow(
      /not found or not executable/i,
    );
  });
});
