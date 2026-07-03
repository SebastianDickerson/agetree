/**
 * The `agetree rm <branch-or-lane> [--force]` command: tear down a lane's
 * worktree by delegating to the Bash engine, then clean up the lane's
 * `.agetree/` record + log.
 *
 * This is a PASSTHROUGH command (ts-bash-boundary): the engine runs over
 * inherited stdio so the container teardown and the interactive "delete the
 * branch too?" prompt behave exactly like `agent-worktree.sh rm`. There is no
 * `--json`. The engine's exit code is preserved verbatim; the TS wrapper only
 * returns exit 2 if it fails before invoking Bash (normalization error).
 *
 * Cleanup is the record-scoped slice `lane-gc` handed this verb (see
 * `lane-cleanup.ts`): only after the engine returns exit 0, only for a record
 * whose worktree is verifiably gone, and never fatal on a delete failure.
 */

import type { Writable } from "node:stream";
import { createEngine, type Engine } from "./engine.ts";
import { cleanupVanished, type LaneStoreDeps, msgOf, normalizeIdentifier } from "./lane-cleanup.ts";

export type RunRmOptions = {
  repoRoot: string;
  /** A lane record name or a branch — normalized to the branch the engine removes. */
  identifier: string;
  /** `--force`: forwarded to the engine's `rm`. */
  force?: boolean;
  out?: Writable;
  err?: Writable;
  // ── injectables (tests / advanced callers) ──
  engine?: Engine;
} & LaneStoreDeps;

export type RunRmResult = { exitCode: number };

/**
 * Remove a lane/worktree, then prune its `.agetree/` record if the worktree is
 * gone afterwards. Returns the engine's exit code (2 only on a pre-engine TS
 * failure).
 */
export async function runRm(opts: RunRmOptions): Promise<RunRmResult> {
  const err = opts.err ?? process.stderr;

  let normalized;
  try {
    normalized = normalizeIdentifier(opts.repoRoot, opts.identifier, opts);
    const engine = opts.engine ?? createEngine({ cwd: opts.repoRoot });
    const exitCode = await engine.remove(normalized.branch, { force: opts.force });

    // Cleanup is gated on success: on any engine failure, leave the record for
    // inspection (the worktree may still exist).
    if (exitCode === 0 && normalized.recordName) {
      await cleanupVanished({
        root: opts.repoRoot,
        candidateNames: [normalized.recordName],
        err,
        deps: opts,
      });
    }
    return { exitCode };
  } catch (error) {
    err.write(`agetree: ${msgOf(error)}\n`);
    return { exitCode: 2 };
  }
}
