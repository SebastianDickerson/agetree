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

/** Default grace between SIGTERM and SIGKILL when signalling a process group. */
export const DEFAULT_GRACE_MS = 5_000;

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
  /** Best-effort group-kill a `stale` lane whose process group still exists (opt-in). */
  killOrphans?: boolean;
  // ── injectables (tests / advanced callers) ──
  now?: () => number;
  /** Leader liveness (`process.kill(pid, 0)`), for reconcile facts + the kill guard. */
  isAlive?: (pid: number) => boolean;
  /** Group liveness (`process.kill(-pgid, 0)`), for the `--kill-orphans` guard. */
  groupAlive?: (pgid: number) => boolean;
  /**
   * Actual start time of the live supervisor pid, the pid-recycle discriminator
   * reconcile compares against `record.supervisorStartedAt`. Default `undefined`
   * (no probe — same limitation as `ls`); tests inject it to exercise recycle.
   */
  startedAtOf?: (pid: number) => number | undefined;
  /** Signal a whole process group (`kill(-pgid, sig)`); supervisor is the setsid group leader. */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  /** Grace sleep between SIGTERM and SIGKILL; injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
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

/** All gc seams resolved to concrete functions — passed to the per-lane helpers. */
type GcCtx = {
  repoRoot: string;
  dryRun: boolean;
  killOrphans: boolean;
  now: () => number;
  isAlive: (pid: number) => boolean;
  groupAlive: (pgid: number) => boolean;
  startedAtOf: (pid: number) => number | undefined;
  killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  graceMs: number;
  maxRunMs?: number;
  readRecord: (root: string, name: string) => LaneRecord | null;
  writeRecord: (root: string, record: LaneRecord) => void;
};

/**
 * Run the janitor and return a structured summary. Pure of output concerns
 * (the `runGc` command wraps this with formatting + exit codes, added later).
 */
export async function gc(opts: GcOptions): Promise<GcSummary> {
  const ctx: GcCtx = {
    repoRoot: opts.repoRoot,
    dryRun: opts.dryRun ?? false,
    killOrphans: opts.killOrphans ?? false,
    now: opts.now ?? Date.now,
    isAlive: opts.isAlive ?? processAlive,
    groupAlive: opts.groupAlive ?? defaultGroupAlive,
    startedAtOf: opts.startedAtOf ?? (() => undefined),
    killGroup: opts.killGroup ?? defaultKillGroup,
    sleep: opts.sleep ?? defaultSleep,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    maxRunMs: opts.maxRunMs,
    readRecord: opts.readRecord ?? readLaneRecord,
    writeRecord: opts.writeRecord ?? writeLaneRecordAtomic,
  };
  const listWorktrees = opts.listWorktrees ?? defaultWorktreeReader;
  const readNames = opts.readLaneNames ?? listLaneNames;

  const summary: GcSummary = { healed: [], killed: [], pruned: [], skipped: [] };
  const worktrees = await listWorktrees(opts.repoRoot);

  // ── Pass 1: persist-heal + kill ──
  for (const name of readNames(opts.repoRoot)) {
    const record = ctx.readRecord(opts.repoRoot, name);
    if (!record) continue;

    const { record: reconciled, changed } = reconcile(record, {
      now: ctx.now(),
      supervisor: {
        alive: ctx.isAlive(record.supervisorPid),
        startedAt: ctx.startedAtOf(record.supervisorPid),
      },
      worktreeExists: worktrees.has(record.branch),
      maxRunMs: ctx.maxRunMs,
    });

    // !changed ⇒ a healthy `running` or an already-terminal record: never rewrite.
    if (!changed) continue;

    // Kill BEFORE the guarded heal: a timed-out supervisor is alive and might
    // record its own terminal status while dying in the grace window, so the
    // heal's re-read (after the kill) is what decides whether to persist.
    await maybeKill(ctx, name, record, reconciled.status, summary);
    healLane(ctx, name, record, reconciled, summary);
  }

  return summary;
}

/**
 * Signal the lane's process group when the healed status calls for it:
 *  - `timed-out` (supervisor alive, over budget): re-check the pid is still
 *    alive AND still this lane's supervisor (pid-recycle guard) right before
 *    signalling, then SIGTERM → grace → SIGKILL the group.
 *  - `stale` (supervisor pid already dead): no kill by default — a reparented
 *    orphan can't be reliably identified. With `--kill-orphans`, best-effort
 *    group kill guarded by the group still existing.
 * A failed kill on one lane is reported (`skipped`) but never aborts the run.
 */
async function maybeKill(
  ctx: GcCtx,
  name: string,
  record: LaneRecord,
  healedStatus: Status,
  summary: GcSummary,
): Promise<void> {
  const pgid = record.supervisorPid; // setsid group leader ⇒ pgid == supervisorPid

  if (healedStatus === STATUS.TIMED_OUT) {
    const guard = timedOutKillGuard(ctx, name, record);
    if (guard) {
      summary.skipped.push({ name, reason: guard });
      return;
    }
    await escalate(ctx, name, pgid, ctx.isAlive, summary);
    return;
  }

  if (healedStatus === STATUS.STALE && ctx.killOrphans) {
    // Leader is dead; only signal if the group still has (reparented) members.
    if (!ctx.groupAlive(pgid)) return;
    await escalate(ctx, name, pgid, ctx.groupAlive, summary);
  }
}

/** The pid-recycle / already-finished guard for a timed-out kill; returns a skip reason or `null`. */
function timedOutKillGuard(ctx: GcCtx, name: string, record: LaneRecord): string | null {
  const fresh = ctx.readRecord(ctx.repoRoot, name);
  if (!fresh || fresh.status !== STATUS.RUNNING) return "supervisor finished before kill";
  if (!ctx.isAlive(fresh.supervisorPid)) return "supervisor already dead before kill";
  const startedAt = ctx.startedAtOf(fresh.supervisorPid);
  if (startedAt !== undefined && startedAt !== record.supervisorStartedAt) {
    return "supervisor pid was recycled before kill";
  }
  return null;
}

/**
 * SIGTERM the group, wait the grace, then SIGKILL if `stillAlive` reports the
 * group survived. Records the signals sent (or, under `--dry-run`, the intended
 * escalation without signalling). A throw from `killGroup` is captured as a
 * non-fatal `skipped` entry.
 */
async function escalate(
  ctx: GcCtx,
  name: string,
  pgid: number,
  stillAlive: (pgid: number) => boolean,
  summary: GcSummary,
): Promise<void> {
  if (ctx.dryRun) {
    summary.killed.push({ name, pgid, signals: ["SIGTERM", "SIGKILL"] });
    return;
  }
  const signals: NodeJS.Signals[] = [];
  try {
    ctx.killGroup(pgid, "SIGTERM");
    signals.push("SIGTERM");
    await ctx.sleep(ctx.graceMs);
    if (stillAlive(pgid)) {
      ctx.killGroup(pgid, "SIGKILL");
      signals.push("SIGKILL");
    }
    summary.killed.push({ name, pgid, signals });
  } catch (error) {
    summary.skipped.push({ name, reason: `kill failed: ${errorMessage(error)}` });
  }
}

/**
 * Persist a computed heal under the guarded RMW that avoids the resurrection
 * race: re-read the file immediately before writing and confirm it is STILL
 * `running` with the SAME `supervisorPid` + `supervisorStartedAt`. If the
 * supervisor won the race (record now terminal, or pid/startedAt differ), keep
 * the supervisor's record and discard gc's heal. The atomic temp+rename write
 * means concurrent readers never see torn JSON, so one file per lane needs no
 * lock.
 */
function healLane(
  ctx: GcCtx,
  name: string,
  from: LaneRecord,
  reconciled: LaneRecord,
  summary: GcSummary,
): void {
  const fresh = ctx.readRecord(ctx.repoRoot, name);
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

  if (!ctx.dryRun) ctx.writeRecord(ctx.repoRoot, reconciled);
  summary.healed.push({ name, from: from.status, to: reconciled.status });
}

// ── default seams (real process/signal/clock) ──

function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
  process.kill(-pgid, signal);
}

function defaultGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
