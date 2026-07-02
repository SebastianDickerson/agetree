import { describe, expect, it } from "vitest";
import {
  STATUS,
  agentExit,
  reconcile,
  spawnRecord,
  type LaneRecord,
} from "./lane-state.ts";

const startedAt = 1_000;

function running(overrides: Partial<LaneRecord> = {}): LaneRecord {
  return {
    ...spawnRecord({
      name: "lane-a",
      branch: "agetree/lane-a",
      adapter: "fake",
      prompt: "do it",
      supervisorPid: 1234,
      supervisorStartedAt: 900,
      startedAt,
      logPath: ".agetree/logs/lane-a.log",
    }),
    ...overrides,
  };
}

describe("reconcile", () => {
  it("leaves a live running supervisor running", () => {
    const result = reconcile(running(), {
      now: startedAt + 50,
      supervisor: { alive: true, startedAt: 900 },
      worktreeExists: true,
      maxRunMs: 1_000,
    });

    expect(result.changed).toBe(false);
    expect(result.record.status).toBe(STATUS.RUNNING);
    expect(result.record.orphaned).toBeUndefined();
  });

  it("classifies a dead running supervisor as stale without writing to disk", () => {
    const result = reconcile(running(), {
      now: startedAt + 50,
      supervisor: { alive: false },
      worktreeExists: true,
      maxRunMs: 1_000,
    });

    expect(result.changed).toBe(true);
    expect(result.record.status).toBe(STATUS.STALE);
    expect(result.record.endedAt).toBe(startedAt + 50);
    expect(result.record.payload).toMatchObject({
      exitCode: -1,
      finalMessage: "",
      reason: "supervisor died without recording completion",
    });
  });

  it("treats a recycled supervisor pid as stale even if that pid is alive", () => {
    const result = reconcile(running(), {
      now: startedAt + 50,
      supervisor: { alive: true, startedAt: 950 },
      worktreeExists: true,
      maxRunMs: 1_000,
    });

    expect(result.changed).toBe(true);
    expect(result.record.status).toBe(STATUS.STALE);
    expect(result.record.payload).toMatchObject({ reason: "supervisor pid was recycled" });
  });

  it("prefers stale over timed-out when the recorded supervisor is gone", () => {
    const result = reconcile(running(), {
      now: startedAt + 5_000,
      supervisor: { alive: false },
      worktreeExists: true,
      maxRunMs: 1_000,
    });

    expect(result.record.status).toBe(STATUS.STALE);
  });

  it("classifies a live over-budget supervisor as timed-out", () => {
    const result = reconcile(running(), {
      now: startedAt + 5_000,
      supervisor: { alive: true, startedAt: 900 },
      worktreeExists: true,
      maxRunMs: 1_000,
    });

    expect(result.changed).toBe(true);
    expect(result.record.status).toBe(STATUS.TIMED_OUT);
    expect(result.record.payload).toMatchObject({
      exitCode: -1,
      finalMessage: "",
      reason: "exceeded max run budget of 1000ms",
    });
  });

  it("marks only terminal records with missing worktrees as orphaned", () => {
    const done = running({ status: STATUS.DONE, endedAt: 2_000, payload: null });

    const result = reconcile(done, {
      now: 3_000,
      supervisor: { alive: false },
      worktreeExists: false,
    });

    expect(result.changed).toBe(false);
    expect(result.record).toMatchObject({ status: STATUS.DONE, orphaned: true });
  });
});

describe("agentExit commit policy", () => {
  it("marks exit 0 with an auto-commit as done", () => {
    const result = agentExit(running(), {
      now: 2_000,
      result: { adapter: "fake", exitCode: 0, isError: false, finalMessage: "done" },
      commit: { outcome: "committed", sha: "abc", baseSha: "base" },
      filesChanged: { count: 1, files: ["src/a.ts"], truncated: false },
    });

    expect(result.status).toBe(STATUS.DONE);
    expect(result.payload).toEqual({
      exitCode: 0,
      isError: false,
      finalMessage: "done",
      commit: { outcome: "committed", sha: "abc", baseSha: "base" },
      filesChanged: { count: 1, files: ["src/a.ts"], truncated: false },
    });
  });

  it("marks exit 0 with nothing to commit as done", () => {
    const result = agentExit(running(), {
      now: 2_000,
      result: { adapter: "fake", exitCode: 0, isError: false, finalMessage: "nothing" },
      commit: { outcome: "nothing", sha: "head", baseSha: "head" },
      filesChanged: { count: 0, files: [], truncated: false },
    });

    expect(result.status).toBe(STATUS.DONE);
    expect(result.payload?.commit).toEqual({ outcome: "nothing", sha: "head", baseSha: "head" });
  });

  it("marks exit 0 with a commit error as failed", () => {
    const result = agentExit(running(), {
      now: 2_000,
      result: { adapter: "fake", exitCode: 0, isError: false, finalMessage: "done" },
      commit: { outcome: "error" },
      filesChanged: { count: 1, files: ["src/a.ts"], truncated: false },
      reason: "auto-commit failed: no identity",
    });

    expect(result.status).toBe(STATUS.FAILED);
    expect(result.payload).toMatchObject({
      exitCode: 0,
      finalMessage: "done",
      reason: "auto-commit failed: no identity",
      commit: { outcome: "error" },
    });
  });

  it("marks non-zero agent exit as failed and skips commit", () => {
    const result = agentExit(running(), {
      now: 2_000,
      result: { adapter: "fake", exitCode: 2, isError: true, finalMessage: "boom" },
      commit: { outcome: "skipped" },
      filesChanged: { count: 1, files: ["src/a.ts"], truncated: false },
    });

    expect(result.status).toBe(STATUS.FAILED);
    expect(result.payload).toMatchObject({
      exitCode: 2,
      isError: true,
      finalMessage: "boom",
      reason: "agent exited 2",
      commit: { outcome: "skipped" },
    });
  });
});
