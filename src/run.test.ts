import { describe, expect, it } from "vitest";
import type { LaneRecord } from "./lane-state.ts";
import { autoName, formatOutput } from "./run.ts";

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
