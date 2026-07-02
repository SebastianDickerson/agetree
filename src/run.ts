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

import { existsSync, readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createEngine, type Engine } from "./engine.ts";
import { isTerminal, reconcile, STATUS, type LaneRecord } from "./lane-state.ts";
import { readLaneRecord } from "./lane-store.ts";
import { spawnDetachedSupervisor, type SpawnProcess } from "./supervisor.ts";

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

export type PromptSource = {
  /** Inline prompt text (`--prompt`). */
  prompt?: string;
  /** Path to a prompt file (`--prompt-file`); `-` reads stdin. */
  promptFile?: string;
};

/**
 * Resolve the headless prompt from `--prompt` or `--prompt-file` (mutually
 * exclusive; `-` reads stdin). Exactly one must be provided.
 */
export async function resolvePrompt(source: PromptSource): Promise<string> {
  if (source.prompt !== undefined && source.promptFile !== undefined) {
    throw new Error("--prompt and --prompt-file are mutually exclusive");
  }
  if (source.prompt !== undefined) return source.prompt;
  if (source.promptFile !== undefined) {
    return source.promptFile === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(source.promptFile, "utf8");
  }
  throw new Error("run requires --prompt or --prompt-file");
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
  return formatStarted(record.name, opts.pid ?? record.supervisorPid);
}

/** The background one-liner emitted when neither --wait nor --json is set. */
export function formatStarted(name: string, pid: number): string {
  return `lane ${name} started, pid ${pid}\n`;
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

// ── Orchestration ─────────────────────────────────────────────────────────

const DEFAULT_ENTRYPOINT = fileURLToPath(new URL("./supervisor-main.ts", import.meta.url));

export type RunHeadlessOptions = {
  repoRoot: string;
  prompt: string;
  branch?: string;
  base?: string;
  name?: string;
  /** Adapter to drive the lane. Default `fake` for now (real CLIs land later). */
  adapter?: string;
  wait?: boolean;
  json?: boolean;
  /** Optional run budget (ms) used to classify a `timed-out` lane while waiting. */
  timeoutMs?: number;
  // ── injectables (tests / advanced callers) ──
  engine?: Engine;
  now?: () => number;
  /** Parent environment, forwarded to the supervisor (carries AGETREE_DEPTH). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Extra env for the detached supervisor (e.g. AGETREE_FAKE_SPEC). */
  supervisorEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnProcess;
  entrypoint?: string;
  nodeExecArgs?: string[];
  out?: Writable;
  err?: Writable;
  pollIntervalMs?: number;
  isAlive?: (pid: number) => boolean;
};

export type RunHeadlessResult = { exitCode: number };

/**
 * The headless `agetree run --prompt` path. Resolves/auto-names the lane,
 * ensures its worktree, spawns the detached supervisor entrypoint, and shapes
 * output. Returns immediately (background) unless `--wait`, which blocks until
 * the lane record reaches a terminal/reconciled status.
 *
 * Exit codes: without --wait, 0 = spawned OK, 2 = operational error. With
 * --wait, 0 = done, 1 = terminal non-done, 2 = operational error.
 */
export async function runHeadless(opts: RunHeadlessOptions): Promise<RunHeadlessResult> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? false;
  const json = opts.json ?? false;
  const pollIntervalMs = opts.pollIntervalMs ?? 40;
  const isAlive = opts.isAlive ?? processAlive;

  try {
    if (!opts.prompt) throw new Error("run --prompt requires a non-empty prompt");

    const { name, branch } = autoName({
      branch: opts.branch,
      name: opts.name,
      prompt: opts.prompt,
      now,
    });

    const engine =
      opts.engine ?? createEngine({ cwd: opts.repoRoot, redirectEngineOutput: err });
    const { path: worktreePath } = await engine.ensureWorktree(branch, opts.base);

    const entrypoint = opts.entrypoint ?? DEFAULT_ENTRYPOINT;
    const nodeArgs = [...(opts.nodeExecArgs ?? ["--experimental-strip-types"]), entrypoint];
    const childEnv: NodeJS.ProcessEnv = {
      ...(opts.parentEnv ?? process.env),
      ...opts.supervisorEnv,
      AGETREE_REPO_ROOT: opts.repoRoot,
      AGETREE_WORKTREE: worktreePath,
      AGETREE_LANE_NAME: name,
      AGETREE_BRANCH: branch,
      AGETREE_BASE: opts.base ?? "",
      AGETREE_PROMPT: opts.prompt,
      AGETREE_ADAPTER: opts.adapter ?? "fake",
    };
    const pid = spawnDetachedSupervisor({
      command: process.execPath,
      args: nodeArgs,
      cwd: opts.repoRoot,
      env: childEnv,
      spawn: opts.spawn,
    });

    if (!wait) {
      if (json) {
        const record = await pollUntil(
          () => readLaneRecord(opts.repoRoot, name),
          (r) => r !== null,
          { now, pollIntervalMs },
        );
        out.write(formatOutput(record, { json: true, wait: false, orphaned: false }));
      } else {
        out.write(formatStarted(name, pid));
      }
      return { exitCode: 0 };
    }

    const { record, orphaned } = await pollUntil(
      () => reconcileRecord(opts.repoRoot, name, worktreePath, now, isAlive, opts.timeoutMs),
      (r) => r !== null && isTerminal(r.record.status),
      { now, pollIntervalMs },
    );
    out.write(formatOutput(record, { json, wait: true, orphaned }));
    return { exitCode: record.status === STATUS.DONE ? 0 : 1 };
  } catch (error) {
    err.write(`agetree: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}

type Reconciled = { record: LaneRecord; orphaned: boolean };

/** Read + reconcile a lane record; null until it exists on disk. */
function reconcileRecord(
  repoRoot: string,
  name: string,
  worktreePath: string,
  now: () => number,
  isAlive: (pid: number) => boolean,
  maxRunMs?: number,
): Reconciled | null {
  const record = readLaneRecord(repoRoot, name);
  if (!record) return null;
  const { record: reconciled, flags } = reconcile(record, {
    now: now(),
    supervisor: { alive: isAlive(record.supervisorPid) },
    worktreeExists: existsSync(worktreePath),
    maxRunMs,
  });
  return { record: reconciled, orphaned: flags.orphaned };
}

/** Poll `read` until `done` holds; throws (operational error) on timeout. */
async function pollUntil<T>(
  read: () => T,
  done: (value: T) => boolean,
  opts: { now: () => number; pollIntervalMs: number; timeoutMs?: number },
): Promise<NonNullable<T>> {
  const deadline = opts.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const value = read();
    if (done(value)) return value as NonNullable<T>;
    if (opts.now() > deadline) throw new Error("timed out waiting for the lane record");
    await sleep(opts.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
