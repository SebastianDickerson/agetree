/**
 * The headless `agetree run --prompt` orchestration.
 *
 * This wires the two supervisor halves together: it resolves/auto-names the
 * lane, ensures a worktree exists via the engine, spawns the detached
 * supervisor entrypoint (which runs the agent adapter and writes the terminal
 * record), and shapes output per the `result-payload` / `cli-surface`
 * decisions (`--json` / `--wait` orthogonality, JSON-only stdout, exit codes).
 *
 * The pure helpers (`autoName`, `formatOutput`, …) are exported so the naming
 * and output-mode logic can be unit-tested without spawning a subprocess.
 */

import type { LaneRecord } from "./lane-state.ts";

const SLUG_MAX = 40;

/** Turn free text into a filesystem/branch-safe slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/** Derive a filesystem-safe lane name (the record key) from a branch. */
export function deriveLaneName(branch: string): string {
  const stripped = branch.startsWith("agetree/") ? branch.slice("agetree/".length) : branch;
  return stripped.replace(/\//g, "-");
}

export type AutoNameOptions = {
  /** Explicit branch (used verbatim); when absent, a name is auto-generated. */
  branch?: string;
  /** `--name` override for the auto-generated slug. */
  name?: string;
  /** Prompt text, used for the slug when no branch/name is given. */
  prompt: string;
  now?: () => number;
};

/**
 * Resolve the lane's canonical branch + record name. With an explicit branch,
 * use it verbatim; otherwise auto-name `agetree/<slug>-<short-ts>` from
 * `--name` (preferred) or the prompt.
 */
export function autoName(opts: AutoNameOptions): { name: string; branch: string } {
  if (opts.branch) {
    return { branch: opts.branch, name: deriveLaneName(opts.branch) };
  }
  const now = opts.now ?? Date.now;
  const slug = slugify(opts.name ?? opts.prompt) || "lane";
  const ts = now().toString(36);
  const branch = `agetree/${slug}-${ts}`;
  return { branch, name: deriveLaneName(branch) };
}

// ── Output shaping ────────────────────────────────────────────────────────

export type OutputOptions = {
  wait: boolean;
  json: boolean;
  /** Derived orphaned flag (worktree removed); defaults to false. */
  orphaned?: boolean;
  /** Supervisor pid, used only for the background "lane started" one-liner. */
  pid?: number;
};

/**
 * Shape a lane record for output per the emission contract:
 *  - `--json` → the whole record as one newline-terminated JSON object
 *    (supervisor plumbing omitted); caller passes the terminal record under
 *    `--wait` or the initial `running` record otherwise.
 *  - `--wait` (no json) → the human projection.
 *  - neither → the "lane started, pid …" one-liner.
 */
export function formatOutput(record: LaneRecord, opts: OutputOptions): string {
  if (opts.json) return `${JSON.stringify(toPublicRecord(record, opts.orphaned ?? false))}\n`;
  if (opts.wait) return formatHuman(record, opts.orphaned ?? false);
  return `lane ${record.name} started, pid ${opts.pid ?? record.supervisorPid}\n`;
}

/** The public projection of a lane record: supervisor plumbing stripped. */
export function toPublicRecord(
  record: LaneRecord,
  orphaned = false,
): Record<string, unknown> {
  const { supervisorPid: _pid, supervisorStartedAt: _started, orphaned: _o, ...rest } = record;
  return { ...rest, orphaned };
}

const GLYPH: Record<string, string> = {
  done: "✓",
  running: "…",
  failed: "✗",
  stale: "✗",
  "timed-out": "✗",
};

function line(label: string, value: string): string {
  return `  ${label.padEnd(6)}  ${value}\n`;
}

/**
 * Human projection of a lane record (a pure projection of the JSON, never a
 * separate schema): glyph from status + header, key/value lines, then the full
 * finalMessage. Failure leads with `reason` and drops commit/range/files lines.
 */
export function formatHuman(record: LaneRecord, orphaned = false): string {
  const glyph = GLYPH[record.status] ?? "…";
  const duration =
    record.endedAt !== undefined
      ? `${((record.endedAt - record.startedAt) / 1000).toFixed(1)}s`
      : "running";
  const payload = record.payload;

  let out = `${glyph} ${record.status}  lane ${record.name} · ${record.adapter} · ${duration}\n`;

  if (record.status === "done") {
    const count = payload?.filesChanged?.count ?? 0;
    out += line("branch", `${record.branch}   (${count} file${count === 1 ? "" : "s"} changed)`);
    const commit = payload?.commit;
    if (commit?.outcome === "committed") {
      out += line("range", `${commit.baseSha}..${commit.sha}`);
    }
  } else {
    if (payload?.reason) out += line("reason", payload.reason);
    out += line("branch", record.branch);
  }
  if (orphaned) out += line("note", "worktree removed (orphaned)");
  out += line("log", record.logPath);

  const finalMessage = payload?.finalMessage ?? "";
  if (finalMessage) out += `\n${finalMessage}\n`;
  return out;
}
