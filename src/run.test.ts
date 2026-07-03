import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import type { LaneRecord } from "./lane-state.ts";
import { writeLaneRecordAtomic } from "./lane-store.ts";
import { autoName, formatOutput, resolvePrompt, runHeadless } from "./run.ts";
import type { SpawnProcess } from "./supervisor.ts";

function doneRecord(): LaneRecord {
  return {
    name: "feature-x",
    branch: "agetree/feature-x",
    adapter: "fake",
    prompt: "do it",
    supervisorPid: 4321,
    supervisorStartedAt: 1_000,
    status: "done",
    startedAt: 10_000,
    endedAt: 22_400,
    logPath: ".agetree/logs/feature-x.log",
    payload: {
      exitCode: 0,
      isError: false,
      finalMessage: "implemented feature x",
      commit: { outcome: "committed", sha: "d4e5f6a", baseSha: "a1b2c3d" },
      filesChanged: { count: 3, files: ["src/a.ts"], truncated: false },
    },
  };
}

function sink(): Writable {
  return new Writable({ write: (_c, _e, cb) => cb() });
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

/** A running lane record on disk, keyed to the `agetree/feature-x` lane. */
function runningRecord(): LaneRecord {
  return {
    ...doneRecord(),
    status: "running",
    startedAt: 0,
    endedAt: undefined,
    payload: null,
  };
}

/** A spawn stub that pretends to launch the detached supervisor. */
function noopSpawn(): SpawnProcess {
  return () => ({ pid: 4321, unref: () => {} });
}

/**
 * A self-advancing simulated clock: each read jumps `stepMs`, so a tiny real
 * `pollIntervalMs` translates to arbitrarily large *simulated* elapsed time.
 * `at`/`onReach` fire a one-shot side effect once simulated time crosses `at`
 * (used to flip a lane record to a terminal status mid-wait).
 */
function steppingClock(
  stepMs: number,
  opts?: { at: number; onReach: () => void },
): () => number {
  let t = 0;
  let fired = false;
  return () => {
    t += stepMs;
    if (opts && !fired && t >= opts.at) {
      fired = true;
      opts.onReach();
    }
    return t;
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "agetree-wait-"));
}

describe("runHeadless — the --wait loop (startup vs run phases)", () => {
  it("regression: --timeout unset, lane stays running well past 60s then completes → exit 0", async () => {
    // The reported bug: the wait loop's deadline was a hardcoded 60s, so a lane
    // that legitimately runs longer surfaced as an operational exit 2 while it
    // was actually still running fine.
    const repo = tempRepo();
    writeLaneRecordAtomic(repo, runningRecord());
    const out = collector();
    const now = steppingClock(5_000, {
      at: 90_000, // long past the old 60s hardcap
      onReach: () => writeLaneRecordAtomic(repo, doneRecord()),
    });

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "do it",
      branch: "agetree/feature-x",
      engine: stubEngine(),
      spawn: noopSpawn(),
      now,
      isAlive: () => true,
      pollIntervalMs: 1,
      wait: true,
      json: true,
      out,
      err: sink(),
    });

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(out.text).status).toBe("done");
  });

  it("--timeout set, lane exceeds the budget and stays running → timed-out record, exit 1 (not exit 2)", async () => {
    const repo = tempRepo();
    writeLaneRecordAtomic(repo, runningRecord()); // never flips; runs forever
    const out = collector();
    // Budget deliberately > the old 60s hardcap so reconcile's `timed-out`
    // classification must win over any hard deadline (old code threw at 60s).
    const res = await runHeadless({
      repoRoot: repo,
      prompt: "do it",
      branch: "agetree/feature-x",
      engine: stubEngine(),
      spawn: noopSpawn(),
      now: steppingClock(5_000),
      isAlive: () => true,
      pollIntervalMs: 1,
      timeoutMs: 90_000,
      wait: true,
      json: true,
      out,
      err: sink(),
    });

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(out.text).status).toBe("timed-out");
  });

  it("--timeout set, lane completes before the budget → done, exit 0", async () => {
    const repo = tempRepo();
    writeLaneRecordAtomic(repo, runningRecord());
    const out = collector();
    const now = steppingClock(5_000, {
      at: 20_000,
      onReach: () => writeLaneRecordAtomic(repo, doneRecord()),
    });

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "do it",
      branch: "agetree/feature-x",
      engine: stubEngine(),
      spawn: noopSpawn(),
      now,
      isAlive: () => true,
      pollIntervalMs: 1,
      timeoutMs: 90_000,
      wait: true,
      json: true,
      out,
      err: sink(),
    });

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(out.text).status).toBe("done");
  });

  it("--timeout unset, supervisor dies mid-wait → reconcile yields stale, exit 1 (no hang)", async () => {
    const repo = tempRepo();
    writeLaneRecordAtomic(repo, runningRecord());
    const out = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "do it",
      branch: "agetree/feature-x",
      engine: stubEngine(),
      spawn: noopSpawn(),
      now: steppingClock(5_000),
      isAlive: () => false, // supervisor pid is dead
      pollIntervalMs: 1,
      wait: true,
      json: true,
      out,
      err: sink(),
    });

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(out.text).status).toBe("stale");
  });

  it("startup guard: the record never appears within the startup window → operational error, exit 2", async () => {
    const repo = tempRepo(); // no lane record ever written
    const out = collector();
    const err = collector();

    const res = await runHeadless({
      repoRoot: repo,
      prompt: "do it",
      branch: "agetree/feature-x",
      engine: stubEngine(),
      spawn: noopSpawn(),
      now: steppingClock(5_000),
      isAlive: () => true,
      pollIntervalMs: 1,
      startupTimeoutMs: 10_000,
      wait: true,
      json: true,
      out,
      err,
    });

    expect(res.exitCode).toBe(2);
    expect(out.text).toBe(""); // JSON-only stdout: nothing on operational error
    expect(err.text).toMatch(/timed out/i);
  });
});

/** A no-op engine whose ensureWorktree returns a fixed path (no real git). */
function stubEngine(): Engine {
  return {
    ensureWorktree: async (branch) => ({ branch, path: "/lane/wt" }),
    runInteractive: async () => 0,
    merge: async () => 0,
    remove: async () => 0,
  };
}

describe("runHeadless — model plumbing into the supervisor spawn env", () => {
  it("sets AGETREE_MODEL in the detached supervisor env when a model is given", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn: SpawnProcess = (_cmd, _args, opts) => {
      capturedEnv = opts.env;
      return { pid: 4321, unref: () => {} };
    };

    await runHeadless({
      repoRoot: "/repo",
      prompt: "do it",
      branch: "agetree/feature-x",
      adapter: "claude",
      model: "sonnet",
      engine: stubEngine(),
      spawn,
      out: sink(),
      err: sink(),
    });

    expect(capturedEnv?.AGETREE_ADAPTER).toBe("claude");
    expect(capturedEnv?.AGETREE_MODEL).toBe("sonnet");
  });

  it("omits AGETREE_MODEL entirely when no model is given", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn: SpawnProcess = (_cmd, _args, opts) => {
      capturedEnv = opts.env;
      return { pid: 4321, unref: () => {} };
    };

    await runHeadless({
      repoRoot: "/repo",
      prompt: "do it",
      branch: "agetree/feature-x",
      adapter: "claude",
      engine: stubEngine(),
      spawn,
      out: sink(),
      err: sink(),
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("AGETREE_MODEL");
  });
});

describe("autoName", () => {
  it("uses an explicit branch verbatim and derives a filesystem-safe lane name", () => {
    expect(autoName({ branch: "agetree/feature-x", prompt: "whatever" })).toEqual({
      branch: "agetree/feature-x",
      name: "feature-x",
    });
  });

  it("auto-generates agetree/<slug>-<ts> from the prompt when no branch is given", () => {
    const result = autoName({ prompt: "Implement the Foo Bar!!", now: () => 0 });
    expect(result.branch).toBe("agetree/implement-the-foo-bar-0");
    expect(result.name).toBe("implement-the-foo-bar-0");
  });

  it("prefers --name over the prompt for the slug", () => {
    const result = autoName({ name: "Nice Slug", prompt: "ignored prompt", now: () => 0 });
    expect(result.branch).toBe("agetree/nice-slug-0");
  });
});

describe("resolvePrompt", () => {
  it("returns an inline --prompt verbatim", async () => {
    expect(await resolvePrompt({ prompt: "do the thing" })).toBe("do the thing");
  });

  it("reads --prompt-file from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agetree-prompt-"));
    const file = join(dir, "task.md");
    writeFileSync(file, "task from a file\n");
    expect(await resolvePrompt({ promptFile: file })).toBe("task from a file\n");
  });

  it("rejects when neither --prompt nor --prompt-file is given", async () => {
    await expect(resolvePrompt({})).rejects.toThrow(/--prompt/);
  });

  it("rejects when both --prompt and --prompt-file are given", async () => {
    await expect(resolvePrompt({ prompt: "a", promptFile: "b" })).rejects.toThrow(
      /mutually exclusive/i,
    );
  });
});

describe("formatOutput — JSON mode", () => {
  it("emits the whole record as one newline-terminated JSON object, omitting supervisor plumbing", () => {
    const out = formatOutput(doneRecord(), { wait: true, json: true, orphaned: false });

    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd()).not.toContain("\n"); // exactly one line

    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      name: "feature-x",
      branch: "agetree/feature-x",
      status: "done",
      adapter: "fake",
      orphaned: false,
      payload: {
        exitCode: 0,
        finalMessage: "implemented feature x",
        commit: { outcome: "committed", sha: "d4e5f6a", baseSha: "a1b2c3d" },
      },
    });
    expect(parsed).not.toHaveProperty("supervisorPid");
    expect(parsed).not.toHaveProperty("supervisorStartedAt");
  });

  it("emits the initial running record as JSON when --json is set without --wait", () => {
    const running: LaneRecord = {
      ...doneRecord(),
      status: "running",
      endedAt: undefined,
      payload: null,
    };
    const parsed = JSON.parse(formatOutput(running, { wait: false, json: true }));
    expect(parsed.status).toBe("running");
    expect(parsed.payload).toBeNull();
  });
});

describe("formatOutput — human mode", () => {
  it("projects a done lane with glyph, header, range, files, and full finalMessage", () => {
    const out = formatOutput(doneRecord(), { wait: true, json: false });

    expect(out).toContain("✓ done  lane feature-x · fake · 12.4s");
    expect(out).toContain("(3 files changed)");
    expect(out).toContain("range   a1b2c3d..d4e5f6a");
    expect(out).toContain(".agetree/logs/feature-x.log");
    expect(out).toContain("implemented feature x");
  });

  it("leads a failure with the reason and drops the range/files lines", () => {
    const failed: LaneRecord = {
      ...doneRecord(),
      status: "failed",
      payload: {
        exitCode: 2,
        isError: true,
        finalMessage: "could not finish",
        reason: "agent exited 2",
        commit: { outcome: "skipped" },
        filesChanged: { count: 1, files: ["src/broken.txt"], truncated: false },
      },
    };
    const out = formatOutput(failed, { wait: true, json: false });

    expect(out).toContain("✗ failed  lane feature-x");
    expect(out).toContain("reason  agent exited 2");
    expect(out).not.toContain("range");
    expect(out).not.toContain("files changed");
    expect(out).toContain("could not finish");
  });

  it("prints a one-liner with the pid when neither --wait nor --json is set", () => {
    const running: LaneRecord = { ...doneRecord(), status: "running", endedAt: undefined };
    const out = formatOutput(running, { wait: false, json: false, pid: 9999 });
    expect(out).toBe("lane feature-x started, pid 9999\n");
  });
});
