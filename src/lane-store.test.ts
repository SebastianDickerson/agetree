import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneRecord, statePaths, writeLaneRecordAtomic } from "./lane-store.ts";
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
