/**
 * Shared plumbing for the two lifecycle verbs that delegate a worktree/branch
 * effect to the Bash engine and then clean up `.agetree/` state — `rm` and
 * `merge --rm`.
 *
 * Two concerns live here, both reused verbatim by `rm.ts` and `merge.ts`:
 *
 *  1. **lane→branch normalization** (`normalizeIdentifier`). Unlike `logs`'
 *     `resolveLaneName`, these verbs operate on worktrees/branches that may have
 *     no lane record (interactive worktrees, raw branches), so the resolver
 *     FALLS THROUGH to a bare branch instead of hard-failing "no such lane".
 *     When the identifier does map to a record, its name is remembered so the
 *     record's `.agetree/` artifacts can be cleaned up afterwards.
 *
 *  2. **post-effect, git-verified, failure-safe cleanup** (`cleanupVanished`).
 *     Cleanup deletes a lane's `.json` + `.log` (via the shared
 *     `deleteLaneArtifacts` primitive) ONLY after the engine succeeds and ONLY
 *     for a record whose worktree is *verifiably gone* — re-read from git AFTER
 *     the engine ran, never trusted from Bash stdout. This is exactly the
 *     record-scoped slice `lane-gc` handed these verbs; it never touches a
 *     worktree/branch (that stays the engine's job — the seam is
 *     one-directional). An artifact-delete failure is reported to stderr but
 *     never fails the command (gc's orphan-prune is the backstop).
 */

import type { Writable } from "node:stream";
import { defaultWorktreeReader, type WorktreeReader } from "./engine.ts";
import type { LaneRecord } from "./lane-state.ts";
import { deleteLaneArtifacts, listLaneNames, readLaneRecord } from "./lane-store.ts";

/** A resolved identifier: the branch the engine acts on + the lane record (if any) to clean up. */
export type NormalizedIdentifier = {
  /** The canonical branch handed to the engine. */
  branch: string;
  /** The lane record name whose artifacts to clean up, or undefined for a bare branch. */
  recordName?: string;
};

/** The injectable record/store seams both verbs share (defaults resolve to the real store). */
export type LaneStoreDeps = {
  readLaneNames?: (root: string) => string[];
  readRecord?: (root: string, name: string) => LaneRecord | null;
  deleteArtifacts?: (root: string, name: string) => void;
  listWorktrees?: WorktreeReader;
};

/**
 * Resolve a lane-or-branch identifier to the branch the engine acts on, plus
 * the record name to clean up if one exists. Precedence mirrors `logs`'
 * `resolveLaneName` but FALLS THROUGH instead of throwing:
 *   1. a record whose file name matches → its `branch` (remember the record);
 *   2. a record whose `branch` matches → that identifier (remember the record);
 *   3. otherwise treat the identifier AS a bare branch (no record to clean up).
 */
export function normalizeIdentifier(
  root: string,
  identifier: string,
  deps: LaneStoreDeps = {},
): NormalizedIdentifier {
  const readNames = deps.readLaneNames ?? listLaneNames;
  const readRecord = deps.readRecord ?? readLaneRecord;

  const byName = readRecord(root, identifier);
  if (byName) return { branch: byName.branch, recordName: byName.name };

  for (const candidate of readNames(root)) {
    const record = readRecord(root, candidate);
    if (record && record.branch === identifier) {
      return { branch: identifier, recordName: record.name };
    }
  }

  return { branch: identifier };
}

/**
 * Delete the `.agetree/` artifacts of every candidate record whose worktree is
 * verifiably gone. Re-reads git worktrees AFTER the engine ran; a record whose
 * worktree STILL exists is left alone (deleting it would demote a live lane to a
 * bare worktree and lose its payload — exactly what `lane-gc` warns against).
 *
 * Failure-safe: a re-read failure or a per-record delete failure is reported to
 * stderr and never thrown — the caller preserves the engine's exit code.
 */
export async function cleanupVanished(opts: {
  root: string;
  /** Record names to consider (rm: the one record; merge: the branch list's / all records). */
  candidateNames: string[];
  err: Writable;
  deps?: LaneStoreDeps;
}): Promise<void> {
  const readRecord = opts.deps?.readRecord ?? readLaneRecord;
  const del = opts.deps?.deleteArtifacts ?? deleteLaneArtifacts;
  const listWorktrees = opts.deps?.listWorktrees ?? defaultWorktreeReader;

  let worktrees: Map<string, string>;
  try {
    worktrees = await listWorktrees(opts.root);
  } catch (error) {
    opts.err.write(`agetree: lane cleanup skipped (could not read worktrees): ${msgOf(error)}\n`);
    return;
  }

  for (const name of opts.candidateNames) {
    const record = readRecord(opts.root, name);
    if (!record) continue;
    // Never delete a record whose worktree is still present — only vanished ones.
    if (worktrees.has(record.branch)) continue;
    try {
      del(opts.root, name);
    } catch (error) {
      opts.err.write(`agetree: could not remove lane artifacts for '${name}': ${msgOf(error)}\n`);
    }
  }
}

export function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
