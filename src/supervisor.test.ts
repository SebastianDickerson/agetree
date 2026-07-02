import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "./adapters/fake.ts";
import { readLaneRecord, statePaths } from "./lane-store.ts";
import { STATUS } from "./lane-state.ts";
import {
  nextAgetreeDepth,
  runLaneSupervisor,
  spawnDetachedSupervisor,
  type SpawnProcess,
} from "./supervisor.ts";

function sh(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" }).trim();
}

function freshRepo(): { repo: string; baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-supervisor-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  const baseSha = sh(repo, ["git", "rev-parse", "HEAD"]);
  sh(repo, ["git", "switch", "-c", "agetree/feature-x"]);
  return { repo, baseSha };
}

describe("spawnDetachedSupervisor", () => {
  it("spawns the supervisor detached and unrefs it so run can return", () => {
    const calls: unknown[] = [];
    let unrefCalled = false;
    const spawn: SpawnProcess = (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { pid: 777, unref: () => void (unrefCalled = true) };
    };

    const pid = spawnDetachedSupervisor({
      command: "/usr/bin/node",
      args: ["supervisor.mjs", "payload"],
      cwd: "/repo",
      env: { A: "B" },
      spawn,
    });

    expect(pid).toBe(777);
    expect(unrefCalled).toBe(true);
    expect(calls).toEqual([
      [
        "/usr/bin/node",
        ["supervisor.mjs", "payload"],
        { cwd: "/repo", env: { A: "B" }, detached: true, stdio: "ignore" },
      ],
    ]);
  });
});

describe("AGETREE_DEPTH", () => {
  it("injects parent depth + 1, defaulting the parent to zero", () => {
    expect(nextAgetreeDepth({})).toBe("1");
    expect(nextAgetreeDepth({ AGETREE_DEPTH: "1" })).toBe("2");
  });
});

describe("runLaneSupervisor", () => {
  it("writes lane state, logs fake-agent output, auto-commits clean exits, and records git facts", async () => {
    const { repo, baseSha } = freshRepo();
    const adapter = createFakeAdapter({
      finalMessage: "implemented feature x",
      writeFiles: [
        { path: "src/feature.txt", content: "hello from a lane\n" },
        { path: ".depth", content: "placeholder" },
      ],
      writeEnv: [{ name: "AGETREE_DEPTH", path: ".depth" }],
      sessionId: "sess-1",
      numTurns: 3,
      durationMs: 42,
    });

    const record = await runLaneSupervisor({
      repoRoot: repo,
      worktreePath: repo,
      name: "feature-x",
      branch: "agetree/feature-x",
      baseRef: "main",
      prompt: "implement feature x",
      adapter,
      parentEnv: {},
      supervisorPid: 4321,
      supervisorStartedAt: 1_234,
      now: (() => {
        let t = 10_000;
        return () => (t += 100);
      })(),
    });

    const stored = readLaneRecord(repo, "feature-x");
    const head = sh(repo, ["git", "rev-parse", "HEAD"]);
    const changed = sh(repo, ["git", "diff", "--name-only", `${baseSha}..${head}`]).split("\n");

    expect(record).toEqual(stored);
    expect(stored).toMatchObject({
      name: "feature-x",
      branch: "agetree/feature-x",
      adapter: "fake",
      supervisorPid: 4321,
      supervisorStartedAt: 1_234,
      status: STATUS.DONE,
      logPath: ".agetree/logs/feature-x.log",
      payload: {
        exitCode: 0,
        isError: false,
        finalMessage: "implemented feature x",
        commit: { outcome: "committed", baseSha, sha: head },
        filesChanged: { count: 2, files: [".depth", "src/feature.txt"], truncated: false },
        sessionId: "sess-1",
        numTurns: 3,
        durationMs: 42,
      },
    });
    expect(changed.sort()).toEqual([".depth", "src/feature.txt"]);
    expect(sh(repo, ["git", "status", "--porcelain"])).toBe("");
    expect(readFileSync(statePaths(repo, "feature-x").logPath, "utf8")).toContain(
      "implemented feature x",
    );
    expect(readFileSync(join(repo, ".depth"), "utf8")).toBe("1");
    expect(sh(repo, ["git", "ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(
      ".agetree",
    );
  });

  it("marks non-zero exits failed, skips commit, and keeps dirty worktree changes", async () => {
    const { repo } = freshRepo();
    const adapter = createFakeAdapter({
      finalMessage: "could not finish",
      exitCode: 2,
      writeFiles: [{ path: "src/broken.txt", content: "dirty\n" }],
    });

    const record = await runLaneSupervisor({
      repoRoot: repo,
      worktreePath: repo,
      name: "broken",
      branch: "agetree/feature-x",
      baseRef: "main",
      prompt: "break it",
      adapter,
      supervisorPid: 4321,
      supervisorStartedAt: 1_234,
    });

    expect(record).toMatchObject({
      status: STATUS.FAILED,
      payload: {
        exitCode: 2,
        isError: true,
        finalMessage: "could not finish",
        reason: "agent exited 2",
        commit: { outcome: "skipped" },
        filesChanged: { count: 1, files: ["src/broken.txt"], truncated: false },
      },
    });
    expect(sh(repo, ["git", "status", "--porcelain", "--untracked-files=all"])).toContain(
      "src/broken.txt",
    );
  });

  it("always writes a terminal record when git bookkeeping fails after the agent ran", async () => {
    const { repo } = freshRepo();
    const adapter = createFakeAdapter({
      finalMessage: "did the work",
      writeFiles: [{ path: "src/work.txt", content: "unsaved\n" }],
    });

    // A base ref that does not exist makes the merge-base bookkeeping throw
    // *after* the agent has already run and written files.
    const record = await runLaneSupervisor({
      repoRoot: repo,
      worktreePath: repo,
      name: "bookkeeping",
      branch: "agetree/feature-x",
      baseRef: "no-such-ref",
      prompt: "do work",
      adapter,
      supervisorPid: 4321,
      supervisorStartedAt: 1_234,
    });

    expect(record.status).toBe(STATUS.FAILED);
    expect(record.payload?.reason).toMatch(/bookkeeping failed/i);
    expect(record.payload?.commit).toEqual({ outcome: "error" });
    // The lane record is persisted (not left stuck as `running`).
    expect(readLaneRecord(repo, "bookkeeping")).toEqual(record);
    // The dirty worktree is kept for inspection.
    expect(sh(repo, ["git", "status", "--porcelain", "--untracked-files=all"])).toContain(
      "src/work.txt",
    );
  });

  it("creates the lane log with 0o600 permissions (logs can contain secrets)", async () => {
    const { repo } = freshRepo();
    const adapter = createFakeAdapter({ finalMessage: "hi" });

    await runLaneSupervisor({
      repoRoot: repo,
      worktreePath: repo,
      name: "secretlog",
      branch: "agetree/feature-x",
      baseRef: "main",
      prompt: "log",
      adapter,
      supervisorPid: 4321,
      supervisorStartedAt: 1_234,
    });

    const mode = statSync(statePaths(repo, "secretlog").logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
