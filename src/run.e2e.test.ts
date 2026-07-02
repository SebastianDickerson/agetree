import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import { isTerminal, type LaneRecord, type Status } from "./lane-state.ts";
import { readLaneRecord } from "./lane-store.ts";
import { runHeadless } from "./run.ts";

function sh(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** A throwaway repo with a lane worktree already created (so ensureWorktree is a no-op). */
function freshRepoWithWorktree(): { repo: string; worktree: string; baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-run-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  const baseSha = sh(repo, ["git", "rev-parse", "HEAD"]);
  const worktree = `${repo}-wt`;
  sh(repo, ["git", "worktree", "add", worktree, "-b", "agetree/feature-x", "main"]);
  return { repo, worktree, baseSha };
}

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

async function pollRecord(repo: string, name: string): Promise<LaneRecord> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rec = readLaneRecord(repo, name);
    if (rec && isTerminal(rec.status as Status)) return rec;
    if (Date.now() > deadline) throw new Error(`lane ${name} never reached terminal`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("runHeadless (end-to-end via the real detached supervisor)", () => {
  it("--wait --json emits the canonical payload with status/commit range/filesChanged; stdout is JSON-only", async () => {
    const { repo, worktree, baseSha } = freshRepoWithWorktree();
    const spec = {
      finalMessage: "implemented feature x",
      writeFiles: [{ path: "src/feature.txt", content: "hello from a lane\n" }],
      sessionId: "sess-1",
      numTurns: 3,
      durationMs: 42,
    };
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "implement feature x",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: true,
      json: true,
      supervisorEnv: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      out,
      err,
    });

    expect(res.exitCode).toBe(0);

    // stdout is exactly one newline-terminated JSON object, nothing else.
    expect(out.text.endsWith("\n")).toBe(true);
    expect(out.text.trimEnd().split("\n")).toHaveLength(1);

    const payload = JSON.parse(out.text);
    expect(payload).toMatchObject({
      name: "feature-x",
      branch: "agetree/feature-x",
      status: "done",
      adapter: "fake",
      payload: {
        exitCode: 0,
        isError: false,
        finalMessage: "implemented feature x",
        commit: { outcome: "committed", baseSha },
        filesChanged: { count: 1, files: ["src/feature.txt"], truncated: false },
        sessionId: "sess-1",
      },
    });
    expect(payload).not.toHaveProperty("supervisorPid");

    // The commit range really contains the agent's file.
    const head = sh(worktree, ["git", "rev-parse", "HEAD"]);
    expect(payload.payload.commit.sha).toBe(head);
    const changed = sh(worktree, ["git", "diff", "--name-only", `${baseSha}..${head}`]);
    expect(changed).toContain("src/feature.txt");
  });

  it("exits 1 under --wait when the lane reaches a terminal non-done status", async () => {
    const { repo } = freshRepoWithWorktree();
    const spec = {
      finalMessage: "could not finish",
      exitCode: 2,
      writeFiles: [{ path: "src/broken.txt", content: "dirty\n" }],
    };
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "break it",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: true,
      json: true,
      supervisorEnv: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      out,
      err,
    });

    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(out.text);
    expect(payload.status).toBe("failed");
    expect(payload.payload.reason).toBe("agent exited 2");
    expect(payload.payload.commit).toEqual({ outcome: "skipped" });
  });

  it("exits 2 on an operational error (engine failure) with empty stdout", async () => {
    const { repo } = freshRepoWithWorktree();
    const brokenEngine: Engine = {
      ensureWorktree: async () => {
        throw new Error("engine boom");
      },
      runInteractive: async () => 0,
      merge: async () => 0,
      remove: async () => 0,
    };
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "whatever",
      branch: "agetree/feature-x",
      adapter: "fake",
      wait: true,
      json: true,
      engine: brokenEngine,
      out,
      err,
    });

    expect(res.exitCode).toBe(2);
    expect(out.text).toBe("");
    expect(err.text).toMatch(/engine boom/);
  });

  it("background (no --wait) returns 0 after spawn, and the lane still reaches terminal", async () => {
    const { repo, baseSha } = freshRepoWithWorktree();
    const spec = {
      finalMessage: "background done",
      writeFiles: [{ path: "src/bg.txt", content: "bg\n" }],
    };
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "background task",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: false,
      json: false,
      supervisorEnv: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      out,
      err,
    });

    expect(res.exitCode).toBe(0);
    expect(out.text).toMatch(/^lane feature-x started, pid \d+\n$/);

    const record = await pollRecord(repo, "feature-x");
    expect(record.status).toBe("done");
    expect(record.payload?.commit).toMatchObject({ outcome: "committed", baseSha });
    expect(record.payload?.finalMessage).toBe("background done");
  });

  it("--json without --wait emits the initial running record", async () => {
    const { repo } = freshRepoWithWorktree();
    // A fake agent that lingers briefly so the record is observed as `running`.
    const spec = { finalMessage: "later", durationMs: 0 };
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "json no wait",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: false,
      json: true,
      supervisorEnv: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      out,
      err,
    });

    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(out.text);
    expect(payload.name).toBe("feature-x");
    expect(["running", "done"]).toContain(payload.status);
    expect(payload).not.toHaveProperty("supervisorPid");
  });
});
