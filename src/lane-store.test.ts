import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteLaneArtifacts,
  readLaneRecord,
  statePaths,
  writeLaneRecordAtomic,
} from "./lane-store.ts";
import { spawnRecord } from "./lane-state.ts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "agetree-store-"));
}

describe("lane-state persistence", () => {
  it("writes one JSON file per lane and keeps logs in the matching log path", () => {
    const root = freshRoot();
    const record = spawnRecord({
      name: "feature-x",
      branch: "agetree/feature-x",
      adapter: "fake",
      prompt: "do x",
      supervisorPid: 123,
      supervisorStartedAt: 456,
      startedAt: 1_000,
      logPath: ".agetree/logs/feature-x.log",
    });

    writeLaneRecordAtomic(root, record);

    const paths = statePaths(root, "feature-x");
    expect(paths.recordPath).toBe(join(root, ".agetree", "lanes", "feature-x.json"));
    expect(paths.logPath).toBe(join(root, ".agetree", "logs", "feature-x.log"));
    expect(existsSync(paths.recordPath)).toBe(true);
    expect(readLaneRecord(root, "feature-x")).toEqual(record);
    expect(readFileSync(paths.recordPath, "utf8")).toContain('"supervisorStartedAt"');
  });

  it("reads never create or rewrite lane files", () => {
    const root = freshRoot();

    expect(readLaneRecord(root, "missing")).toBeNull();
    expect(existsSync(join(root, ".agetree"))).toBe(false);
  });
});

describe("deleteLaneArtifacts", () => {
  it("removes only the lane's .json and .log, leaving other lanes and files alone", () => {
    const root = freshRoot();
    const paths = statePaths(root, "feature-x");
    mkdirSync(paths.lanesDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.recordPath, "{}");
    writeFileSync(paths.logPath, "log bytes");
    // A sibling lane that must survive, plus a stray sentinel in the same tree.
    const other = statePaths(root, "other");
    writeFileSync(other.recordPath, "{}");
    writeFileSync(other.logPath, "other log");
    const sentinel = join(root, ".agetree", "keep-me");
    writeFileSync(sentinel, "x");

    deleteLaneArtifacts(root, "feature-x");

    expect(existsSync(paths.recordPath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
    expect(existsSync(other.recordPath)).toBe(true);
    expect(existsSync(other.logPath)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    // Never touches the state directories themselves.
    expect(existsSync(paths.lanesDir)).toBe(true);
    expect(existsSync(paths.logsDir)).toBe(true);
  });

  it("is idempotent: deleting a lane with no artifacts is not an error", () => {
    const root = freshRoot();
    expect(() => deleteLaneArtifacts(root, "missing")).not.toThrow();
  });
});
