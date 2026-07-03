/**
 * The `agetree gc` janitor — the sole owner of every disk mutation and process
 * kill that happens AFTER a supervisor is gone (lane-gc decision).
 *
 * gc does one pass over `.agetree/lanes/` with three jobs, in order:
 * **persist-heal → kill → prune.** It NEVER touches worktrees or git branches —
 * only `.agetree/` artifacts (the seam stays one-directional: TS owns
 * `.agetree/`, Bash owns worktrees).
 *
 * Classification is not reinvented here: gc calls the pure `reconcile()`
 * (lane-state) to decide stale/timed-out and pid-recycle, then owns only the
 * *policy* — when to persist a heal, when to signal, when to delete. Every
 * process/signal/clock/fs interaction is an injectable seam so the test suite is
 * deterministic and offline (no real signals, no real sleeps, no live
 * processes).
 *
 * This slice lands in stages: persist-heal first, then kill, then prune, then
 * the CLI wiring — each an isolated sharp edge.
 */

import { defaultWorktreeReader, type WorktreeReader } from "./engine.ts";
import { reconcile, STATUS, type LaneRecord, type Status } from "./lane-state.ts";
import { listLaneNames, readLaneRecord, writeLaneRecordAtomic } from "./lane-store.ts";
import { processAlive } from "./run.ts";

/** Default prune window: terminal records older than 7 days age out. */
export const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

/** A `running` record healed into a terminal status (or, under `--dry-run`, that would be). */
export type GcHealed = { name: string; from: Status; to: Status };
/** A process group signalled (or, under `--dry-run`, that would be). */
export type GcKilled = { name: string; pgid: number; signals: string[] };
/** A lane's `.agetree/` artifacts pruned (or, under `--dry-run`, that would be). */
export type GcPruned = { name: string; reason: "orphaned" | "aged" | "keep" };
/** A lane where an action was computed but deliberately not taken (race/guard), or a non-fatal error. */
export type GcSkipped = { name: string; reason: string };

/**
 * The structured gc summary (additive-only / omit-don't-null, like
 * `result-payload`). Arrays are per-ACTION logs, so one lane can appear in more
 * than one (a timed-out lane is both `killed` and `healed`).
 */
export type GcSummary = {
  healed: GcHealed[];
  killed: GcKilled[];
  pruned: GcPruned[];
  skipped: GcSkipped[];
};

export type GcOptions = {
  repoRoot: string;
  /** Report intended heal/kill/prune per lane and touch nothing. */
  dryRun?: boolean;
  // ── injectables (tests / advanced callers) ──
  now?: () => number;
  /** Leader liveness (`process.kill(pid, 0)`), for reconcile facts + the kill guard. */
  isAlive?: (pid: number) => boolean;
  /**
   * Actual start time of the live supervisor pid, the pid-recycle discriminator
   * reconcile compares against `record.supervisorStartedAt`. Default `undefined`
   * (no probe — same limitation as `ls`); tests inject it to exercise recycle.
   */
  startedAtOf?: (pid: number) => number | undefined;
  /**
   * Per-lane run budget used to classify `timed-out`. The budget is NOT
   * persisted in the record, so the CLI leaves this undefined (gc heals `stale`
   * but never `timed-out` in production, exactly like `ls`); tests inject it to
   * exercise the timed-out heal/kill machinery.
   */
  maxRunMs?: number;
  listWorktrees?: WorktreeReader;
  readLaneNames?: (root: string) => string[];
  readRecord?: (root: string, name: string) => LaneRecord | null;
  writeRecord?: (root: string, record: LaneRecord) => void;
};

/**
 * Run the janitor and return a structured summary. Pure of output concerns
 * (the `runGc` command wraps this with formatting + exit codes, added later).
 */
export async function gc(opts: GcOptions): Promise<GcSummary> {
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? processAlive;
  const startedAtOf = opts.startedAtOf ?? (() => undefined);
  const listWorktrees = opts.listWorktrees ?? defaultWorktreeReader;
  const readNames = opts.readLaneNames ?? listLaneNames;
  const readRecord = opts.readRecord ?? readLaneRecord;
  const writeRecord = opts.writeRecord ?? writeLaneRecordAtomic;
  const dryRun = opts.dryRun ?? false;

  const summary: GcSummary = { healed: [], killed: [], pruned: [], skipped: [] };
  const worktrees = await listWorktrees(opts.repoRoot);

  // ── Pass 1: persist-heal ──
  for (const name of readNames(opts.repoRoot)) {
    const record = readRecord(opts.repoRoot, name);
    if (!record) continue;

    const { record: reconciled, changed } = reconcile(record, {
      now: now(),
      supervisor: {
        alive: isAlive(record.supervisorPid),
        startedAt: startedAtOf(record.supervisorPid),
      },
      worktreeExists: worktrees.has(record.branch),
      maxRunMs: opts.maxRunMs,
    });

    // !changed ⇒ a healthy `running` or an already-terminal record: never rewrite.
    if (!changed) continue;

    healLane(opts, { name, from: record, reconciled, dryRun, readRecord, writeRecord, summary });
  }

  return summary;
}

type HealDeps = {
  name: string;
  /** The record as first read (start of pass 1) — the heal's precondition. */
  from: LaneRecord;
  /** The reconciled (healed) record to persist. */
  reconciled: LaneRecord;
  dryRun: boolean;
  readRecord: (root: string, name: string) => LaneRecord | null;
  writeRecord: (root: string, record: LaneRecord) => void;
  summary: GcSummary;
};

/**
 * Persist a computed heal under the guarded RMW that avoids the resurrection
 * race: re-read the file immediately before writing and confirm it is STILL
 * `running` with the SAME `supervisorPid` + `supervisorStartedAt`. If the
 * supervisor won the race (record now terminal, or pid/startedAt differ), keep
 * the supervisor's record and discard gc's heal. The atomic temp+rename write
 * means concurrent readers never see torn JSON, so one file per lane needs no
 * lock.
 */
function healLane(opts: GcOptions, deps: HealDeps): void {
  const { name, from, reconciled, dryRun, readRecord, writeRecord, summary } = deps;

  const fresh = readRecord(opts.repoRoot, name);
  if (!fresh) {
    summary.skipped.push({ name, reason: "record vanished before heal" });
    return;
  }
  if (fresh.status !== STATUS.RUNNING) {
    summary.skipped.push({ name, reason: "supervisor recorded a terminal status first" });
    return;
  }
  if (
    fresh.supervisorPid !== from.supervisorPid ||
    fresh.supervisorStartedAt !== from.supervisorStartedAt
  ) {
    summary.skipped.push({ name, reason: "supervisor pid/start changed before heal" });
    return;
  }

  if (!dryRun) writeRecord(opts.repoRoot, reconciled);
  summary.healed.push({ name, from: from.status, to: reconciled.status });
}
