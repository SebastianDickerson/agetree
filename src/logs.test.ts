import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LaneRecord } from "./lane-state.ts";
import { statePaths, writeLaneRecordAtomic } from "./lane-store.ts";
import { runLogs } from "./logs.ts";

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
    prompt: "do it",
    supervisorPid: 4321,
    supervisorStartedAt: 1_000,
    status: "done",
    startedAt: 10_000,
    endedAt: 22_400,
    logPath: `.agetree/logs/${name}.log`,
    payload: null,
  };
}

/** A repo dir with one lane record and (optionally) a log file of `content`. */
function repoWithLane(
  name: string,
  branch: string,
  content?: string,
): { repo: string; logPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-logs-"));
  writeLaneRecordAtomic(repo, laneRecord(name, branch));
  const { logsDir, logPath } = statePaths(repo, name);
  if (content !== undefined) {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(logPath, content);
  }
  return { repo, logPath };
}

describe("runLogs — resolution", () => {
  it("resolves by lane record name", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "hello\n");
    const out = collector();
    const err = collector();
    const res = await runLogs({ repoRoot: repo, identifier: "feature-x", out, err });
    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("hello\n");
  });

  it("resolves by branch", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "by branch\n");
    const out = collector();
    const err = collector();
    const res = await runLogs({ repoRoot: repo, identifier: "agetree/feature-x", out, err });
    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("by branch\n");
  });

  it("no match → exit 2 with a diagnostic on stderr, nothing on stdout", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "x\n");
    const out = collector();
    const err = collector();
    const res = await runLogs({ repoRoot: repo, identifier: "nope", out, err });
    expect(res.exitCode).toBe(2);
    expect(out.text).toBe("");
    expect(err.text).toMatch(/no such lane: nope/);
  });
});

describe("runLogs — output modes", () => {
  it("prints the whole file by default", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "a\nb\nc\n");
    const out = collector();
    const res = await runLogs({ repoRoot: repo, identifier: "feature-x", out, err: collector() });
    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("a\nb\nc\n");
  });

  it("--lines returns only the last n lines (tail)", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "1\n2\n3\n4\n5\n");
    const out = collector();
    const res = await runLogs({
      repoRoot: repo,
      identifier: "feature-x",
      lines: 2,
      out,
      err: collector(),
    });
    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("4\n5\n");
  });

  it("--lines larger than the file returns the whole file", async () => {
    const { repo } = repoWithLane("feature-x", "agetree/feature-x", "1\n2\n");
    const out = collector();
    await runLogs({ repoRoot: repo, identifier: "feature-x", lines: 99, out, err: collector() });
    expect(out.text).toBe("1\n2\n");
  });

  it("an absent-but-valid log is empty, exit 0", async () => {
    // Lane record exists but no log file was ever flushed.
    const { repo } = repoWithLane("feature-x", "agetree/feature-x");
    const out = collector();
    const err = collector();
    const res = await runLogs({ repoRoot: repo, identifier: "feature-x", out, err });
    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("");
    expect(err.text).toBe("");
  });
});

describe("runLogs — follow", () => {
  it("prints current content, streams an append, then stops via the stop seam", async () => {
    const { repo, logPath } = repoWithLane("feature-x", "agetree/feature-x", "line1\n");
    const out = collector();

    // The stop seam does the append on its first call (so the next poll streams
    // it), then stops on the second call — deterministic, no real waiting.
    let calls = 0;
    const shouldStop = () => {
      calls += 1;
      if (calls === 1) {
        appendFileSync(logPath, "line2\n");
        return false;
      }
      return true;
    };

    const res = await runLogs({
      repoRoot: repo,
      identifier: "feature-x",
      follow: true,
      pollIntervalMs: 1,
      shouldStop,
      out,
      err: collector(),
    });

    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("line1\nline2\n");
  });

  it("--lines + follow prints the tail first, then streams appends", async () => {
    const { repo, logPath } = repoWithLane("feature-x", "agetree/feature-x", "a\nb\nc\n");
    const out = collector();

    let calls = 0;
    const shouldStop = () => {
      calls += 1;
      if (calls === 1) {
        appendFileSync(logPath, "d\n");
        return false;
      }
      return true;
    };

    await runLogs({
      repoRoot: repo,
      identifier: "feature-x",
      follow: true,
      lines: 1,
      pollIntervalMs: 1,
      shouldStop,
      out,
      err: collector(),
    });

    // Tail of the initial file (last 1 line) then the streamed append.
    expect(out.text).toBe("c\nd\n");
  });

  it("follows a log that does not exist yet until it appears", async () => {
    const { repo, logPath } = repoWithLane("feature-x", "agetree/feature-x");
    const { logsDir } = statePaths(repo, "feature-x");
    const out = collector();

    let calls = 0;
    const shouldStop = () => {
      calls += 1;
      if (calls === 1) {
        mkdirSync(logsDir, { recursive: true });
        writeFileSync(logPath, "appeared\n");
        return false;
      }
      return true;
    };

    const res = await runLogs({
      repoRoot: repo,
      identifier: "feature-x",
      follow: true,
      pollIntervalMs: 1,
      shouldStop,
      out,
      err: collector(),
    });

    expect(res.exitCode).toBe(0);
    expect(out.text).toBe("appeared\n");
  });
});
