/**
 * The `agetree logs <branch-or-lane>` command: print or tail a lane's log.
 *
 * Unlike `ls`/`run --json`, logs is a **human-facing text stream**, not part of
 * the parent-agent JSON contract: raw log bytes go to stdout, diagnostics to
 * stderr, and there is no `--json`. It is read-only — it never writes
 * `.agetree/` state.
 *
 * Follow mode polls the log file (NOT `fs.watch`) so tests stay deterministic;
 * the poll loop mirrors `run.ts`'s `pollUntil` style and takes an injectable
 * `shouldStop` seam so a test can stream a few appends and then stop cleanly.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import type { LaneRecord } from "./lane-state.ts";
import { listLaneNames, readLaneRecord, statePaths } from "./lane-store.ts";

export type RunLogsOptions = {
  repoRoot: string;
  /** A lane record name or a branch — resolved to the canonical lane name. */
  identifier: string;
  /** `-f/--follow`: print current content then stream appended output. */
  follow?: boolean;
  /** `--lines <n>`: print only the last n lines (tail semantics). */
  lines?: number;
  out?: Writable;
  err?: Writable;
  // ── injectables (tests / advanced callers) ──
  readLaneNames?: (root: string) => string[];
  readRecord?: (root: string, name: string) => LaneRecord | null;
  /** Follow poll interval; small in tests for determinism. */
  pollIntervalMs?: number;
  /**
   * Follow stop seam: checked once per poll iteration. Default never stops
   * (real `-f` runs until the process is signalled); tests inject a predicate
   * that appends to the log then returns true to end the stream.
   */
  shouldStop?: () => boolean;
};

export type RunLogsResult = { exitCode: number };

/**
 * Print (or tail/follow) a lane's log. Resolves `<branch-or-lane>` to a lane
 * record, reads `.agetree/logs/<name>.log`, and writes raw bytes to stdout.
 *
 * Exit codes (cli-surface): 0 = printed / clean follow stop; 2 = operational
 * error (no such lane, unreadable dir/file). A resolved-but-absent log (lane
 * spawned, not yet flushed) is treated as empty, not an error.
 */
export async function runLogs(opts: RunLogsOptions): Promise<RunLogsResult> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  try {
    const name = resolveLaneName(opts);
    const { logPath } = statePaths(opts.repoRoot, name);

    if (opts.follow) return await followLog(logPath, opts, out);

    // One-shot: absent-but-valid log → empty output, exit 0.
    if (!existsSync(logPath)) return { exitCode: 0 };
    const content = readFileSync(logPath, "utf8");
    out.write(opts.lines !== undefined ? tail(content, opts.lines) : content);
    return { exitCode: 0 };
  } catch (error) {
    err.write(`agetree: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}

/**
 * Resolve `<branch-or-lane>` to a canonical lane name: try a record whose file
 * name matches the identifier first, then scan for one whose `branch` equals
 * it. No match → operational error.
 */
function resolveLaneName(opts: RunLogsOptions): string {
  const readNames = opts.readLaneNames ?? listLaneNames;
  const readRecord = opts.readRecord ?? readLaneRecord;

  const byName = readRecord(opts.repoRoot, opts.identifier);
  if (byName) return byName.name;

  for (const candidate of readNames(opts.repoRoot)) {
    const record = readRecord(opts.repoRoot, candidate);
    if (record && record.branch === opts.identifier) return record.name;
  }

  throw new Error(`no such lane: ${opts.identifier}`);
}

/**
 * Follow the log: emit the current content (or its `--lines` tail), then poll
 * for appended bytes and stream them. Log files only grow in normal operation;
 * a shrink (truncate/rotate) resets the offset and re-emits from the start.
 */
async function followLog(
  logPath: string,
  opts: RunLogsOptions,
  out: Writable,
): Promise<RunLogsResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const shouldStop = opts.shouldStop ?? (() => false);

  let offset = 0;
  if (existsSync(logPath)) {
    const buf = readFileSync(logPath);
    out.write(opts.lines !== undefined ? tail(buf.toString("utf8"), opts.lines) : buf);
    offset = buf.length;
  }

  // Emit any new bytes each tick, then consult the stop seam. Checking stop
  // AFTER emitting means an append made just before the stop is still streamed.
  for (;;) {
    if (existsSync(logPath)) {
      const buf = readFileSync(logPath);
      if (buf.length > offset) {
        out.write(buf.subarray(offset));
        offset = buf.length;
      } else if (buf.length < offset) {
        out.write(buf);
        offset = buf.length;
      }
    }
    if (shouldStop()) return { exitCode: 0 };
    await sleep(pollIntervalMs);
  }
}

/** Last `n` lines of `content`, preserving a trailing newline if present. */
function tail(content: string, n: number): string {
  if (content === "") return "";
  const hadTrailingNewline = content.endsWith("\n");
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lastLines = body.split("\n").slice(-n).join("\n");
  return hadTrailingNewline ? `${lastLines}\n` : lastLines;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
