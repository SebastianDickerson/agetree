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

import type { Writable } from "node:stream";
import { defaultWorktreeReader, type WorktreeReader } from "./engine.ts";
import { reconcile, type LaneRecord } from "./lane-state.ts";
import { listLaneNames, readLaneRecord } from "./lane-store.ts";
import { deriveLaneName, GLYPH, processAlive, toPublicRecord } from "./run.ts";

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

// ── Output shaping ──────────────────────────────────────────────────────────

/** Public projection of one view row: a public lane record or a minimal interactive shape. */
function toPublicView(view: LaneView): Record<string, unknown> {
  if (view.kind === "lane") return toPublicRecord(view.record, view.orphaned);
  return { name: view.name, branch: view.branch, status: INTERACTIVE };
}

/**
 * `--json`: a newline-terminated JSON ARRAY of public records (supervisor
 * plumbing stripped via `toPublicRecord`, derived `orphaned` included);
 * interactive worktrees as a minimal `{name,branch,status:"interactive"}` shape.
 * stdout carries only this array.
 */
export function formatLanesJson(views: LaneView[]): string {
  return `${JSON.stringify(views.map(toPublicView))}\n`;
}

/** Interactive rows sort/display with a dimmed marker glyph. */
const INTERACTIVE_GLYPH = "·";

type Columns = {
  glyph: string;
  status: string;
  name: string;
  branch: string;
  adapter: string;
  age: string;
  note: string;
};

/** Project one view row into table columns (a pure projection of the same data). */
function toColumns(view: LaneView, now: number): Columns {
  if (view.kind === "interactive") {
    return {
      glyph: INTERACTIVE_GLYPH,
      status: INTERACTIVE,
      name: view.name,
      branch: view.branch,
      adapter: "—",
      age: "—",
      note: "interactive (no lane record)",
    };
  }
  const { record, orphaned } = view;
  const elapsed =
    record.endedAt !== undefined ? record.endedAt - record.startedAt : now - record.startedAt;
  return {
    glyph: GLYPH[record.status] ?? "…",
    status: record.status,
    name: record.name,
    branch: record.branch,
    adapter: record.adapter,
    age: formatDuration(elapsed),
    note: orphaned ? "orphaned (worktree removed)" : "",
  };
}

/**
 * Human table: one row per lane (glyph · status · name · branch · adapter ·
 * age/duration · note). A pure projection of the same views the JSON array
 * uses — no separate schema. `now` is injectable so a running lane's elapsed
 * age is deterministic in tests.
 */
export function formatLanesTable(views: LaneView[], opts: { now?: () => number } = {}): string {
  if (views.length === 0) return "no lanes\n";
  const now = (opts.now ?? Date.now)();
  const rows = views.map((v) => toColumns(v, now));

  const w = {
    glyph: maxWidth(rows, "glyph"),
    status: maxWidth(rows, "status"),
    name: maxWidth(rows, "name"),
    branch: maxWidth(rows, "branch"),
    adapter: maxWidth(rows, "adapter"),
    age: maxWidth(rows, "age"),
  };

  return rows
    .map((r) => {
      const cells = [
        r.glyph.padEnd(w.glyph),
        r.status.padEnd(w.status),
        r.name.padEnd(w.name),
        r.branch.padEnd(w.branch),
        r.adapter.padEnd(w.adapter),
        r.age.padStart(w.age),
      ];
      if (r.note) cells.push(r.note);
      return `${cells.join("  ").trimEnd()}\n`;
    })
    .join("");
}

function maxWidth(rows: Columns[], key: keyof Columns): number {
  return rows.reduce((m, r) => Math.max(m, r[key].length), 0);
}

// ── Orchestration ───────────────────────────────────────────────────────────

export type RunListOptions = ListLanesOptions & {
  json?: boolean;
  out?: Writable;
  err?: Writable;
};

export type RunListResult = { exitCode: number };

/**
 * The `agetree ls` command: list + reconcile + shape output. Under `--json`,
 * stdout carries only the JSON array and diagnostics go to stderr. Exit 0
 * normally, 2 on an operational error (e.g. git/dir read failure). Never writes
 * lane state and never kills — it only derives.
 */
export async function runList(opts: RunListOptions): Promise<RunListResult> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  try {
    const views = await listLanes(opts);
    out.write(opts.json ? formatLanesJson(views) : formatLanesTable(views, { now: opts.now }));
    return { exitCode: 0 };
  } catch (error) {
    err.write(`agetree: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}

/** Humanize a duration in ms: "12.4s", "1m30s", "1h02m". */
function formatDuration(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  const seconds = clamped / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}
