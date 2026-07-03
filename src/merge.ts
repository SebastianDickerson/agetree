/**
 * The `agetree merge <target> [branches...] [--all] [--rm]` command: safe
 * merge-back, delegated to the Bash engine, with optional record cleanup.
 *
 * PASSTHROUGH command (ts-bash-boundary): the engine runs over inherited stdio
 * so merge conflicts, the dirty-worktree checks, and container teardown behave
 * exactly like `agent-worktree.sh merge`. No `--json`. The engine's exit code is
 * preserved verbatim (a conflict → non-zero → no cleanup); the TS wrapper only
 * returns exit 2 if it fails before invoking Bash (normalization error).
 *
 * Cleanup is gated on `--rm` (without it the engine leaves worktrees in place,
 * so there is nothing to prune) AND on engine exit 0. It then deletes the
 * `.agetree/` artifacts of every candidate record whose worktree is verifiably
 * gone — which handles an explicit branch list and `--all` uniformly (for
 * `--all`, "targeted" is every record; each is verified against git). The
 * target is never a cleanup candidate: it is merged INTO, not removed. See
 * `lane-cleanup.ts`.
 */

import type { Writable } from "node:stream";
import { createEngine, type Engine } from "./engine.ts";
import { cleanupVanished, type LaneStoreDeps, msgOf, normalizeIdentifier } from "./lane-cleanup.ts";
import { listLaneNames } from "./lane-store.ts";

export type RunMergeOptions = {
  repoRoot: string;
  /** The branch merged into (normalized like the others, but never cleaned up). */
  target: string;
  /** Explicit lane/branch identifiers to merge; ignored by the engine under `--all`. */
  branches: string[];
  /** `--all`: the engine merges every agent worktree except the target. */
  all?: boolean;
  /** `--rm`: the engine removes merged worktrees; gates record cleanup. */
  rm?: boolean;
  out?: Writable;
  err?: Writable;
  // ── injectables (tests / advanced callers) ──
  engine?: Engine;
} & LaneStoreDeps;

export type RunMergeResult = { exitCode: number };

/**
 * Merge `branches` (or, under `--all`, every agent worktree) into `target`,
 * then — only under `--rm` and only after engine exit 0 — prune the
 * `.agetree/` artifacts of any targeted record whose worktree vanished. Returns
 * the engine's exit code (2 only on a pre-engine TS failure).
 */
export async function runMerge(opts: RunMergeOptions): Promise<RunMergeResult> {
  const err = opts.err ?? process.stderr;

  try {
    const target = normalizeIdentifier(opts.repoRoot, opts.target, opts).branch;

    const branches: string[] = [];
    const recordNames: string[] = [];
    for (const identifier of opts.branches) {
      const { branch, recordName } = normalizeIdentifier(opts.repoRoot, identifier, opts);
      branches.push(branch);
      if (recordName) recordNames.push(recordName);
    }

    const engine = opts.engine ?? createEngine({ cwd: opts.repoRoot });
    const exitCode = await engine.merge(target, branches, { all: opts.all, rm: opts.rm });

    // Cleanup only makes sense under --rm (worktrees survive otherwise) and only
    // after a fully-successful merge. For --all the targeted set is every
    // record; each is verified against git so only the removed ones are pruned.
    if (exitCode === 0 && opts.rm) {
      const readNames = opts.readLaneNames ?? listLaneNames;
      const candidateNames = opts.all ? readNames(opts.repoRoot) : recordNames;
      await cleanupVanished({ root: opts.repoRoot, candidateNames, err, deps: opts });
    }
    return { exitCode };
  } catch (error) {
    err.write(`agetree: ${msgOf(error)}\n`);
    return { exitCode: 2 };
  }
}
