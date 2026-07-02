/**
 * The lane-centric `agetree ls`.
 *
 * `listLanes` reads every `.agetree/lanes/*.json` record, reconciles each
 * against the live process + git worktrees, and merges in interactive
 * worktrees (branches with a worktree but no lane record). It is a pure
 * classifier: it NEVER writes to disk and NEVER kills anything (that is `gc`'s
 * job). `maxRunMs` is left undefined so `ls` classifies `stale` but never
 * `timed-out`/kills — consistent with lane-state's "reads never write".
 *
 * Output shaping (`formatLanesJson`, `formatLanesTable`) are pure projections
 * of the same views, so the JSON array and the human table can never drift.
 */

import { defaultWorktreeReader, type WorktreeReader } from "./engine.ts";
import { reconcile, type LaneRecord } from "./lane-state.ts";
import { listLaneNames, readLaneRecord } from "./lane-store.ts";
import { deriveLaneName, processAlive } from "./run.ts";

/** Display marker for a worktree that has no lane record (a human/agent sits in it). */
export const INTERACTIVE = "interactive";

/** A reconciled lane record plus its derived `orphaned` flag. */
export type LaneRow = { kind: "lane"; record: LaneRecord; orphaned: boolean };

/** A git worktree with no lane record — agetree does not drive it. */
export type InteractiveRow = {
  kind: "interactive";
  name: string;
  branch: string;
  path: string;
};

export type LaneView = LaneRow | InteractiveRow;

export type ListLanesOptions = {
  repoRoot: string;
  /**
   * Include interactive worktrees (branches with no lane record). Default
   * `true`: `agetree ls` shows everything reconciled. The map is ambiguous
   * about `--all`; per its "default to showing all" guidance we include
   * interactive worktrees by default, and `all: false` yields a lane-only view.
   */
  all?: boolean;
  // ── injectables (tests / advanced callers) ──
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  listWorktrees?: WorktreeReader;
  readLaneNames?: (root: string) => string[];
  readRecord?: (root: string, name: string) => LaneRecord | null;
};

export async function listLanes(opts: ListLanesOptions): Promise<LaneView[]> {
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? processAlive;
  const listWorktrees = opts.listWorktrees ?? defaultWorktreeReader;
  const readNames = opts.readLaneNames ?? listLaneNames;
  const readRecord = opts.readRecord ?? readLaneRecord;

  const all = opts.all ?? true;

  const worktrees = await listWorktrees(opts.repoRoot);
  const rows: LaneView[] = [];
  const recordedBranches = new Set<string>();

  for (const name of readNames(opts.repoRoot)) {
    const record = readRecord(opts.repoRoot, name);
    if (!record) continue;
    recordedBranches.add(record.branch);
    const { record: reconciled, flags } = reconcile(record, {
      now: now(),
      supervisor: { alive: isAlive(record.supervisorPid) },
      worktreeExists: worktrees.has(record.branch),
      // maxRunMs intentionally undefined — ls classifies for display, never kills.
    });
    rows.push({ kind: "lane", record: reconciled, orphaned: flags.orphaned });
  }

  if (all) {
    for (const [branch, path] of worktrees) {
      if (recordedBranches.has(branch)) continue;
      rows.push({ kind: "interactive", name: deriveLaneName(branch), branch, path });
    }
  }

  // Stable, deterministic order: both row kinds reconcile on `branch`.
  rows.sort((a, b) => branchOf(a).localeCompare(branchOf(b)));
  return rows;
}

function branchOf(view: LaneView): string {
  return view.kind === "lane" ? view.record.branch : view.branch;
}
