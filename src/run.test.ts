import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import type { LaneRecord } from "./lane-state.ts";
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
