/**
 * The `agetree` CLI entrypoint.
 *
 * Turns `agetree <verb> …` into calls to the two built commands (`runHeadless`
 * / `runList`) and the interactive engine passthrough. Parsing is a pure
 * function (`parseCli`) so the whole surface — mode switching, mutual
 * exclusion, flag→field mapping, exit codes — is unit-testable without
 * spawning a subprocess; `runCli` executes a parsed result.
 *
 * Argv parsing uses Node's built-in `util.parseArgs` (no commander/yargs). Per
 * `cli-surface`: prompt presence flips `run` from interactive passthrough to
 * headless orchestration; `--prompt` / `--prompt-file` are mutually exclusive;
 * `--json` and `--wait` are orthogonal; unimplemented verbs stub out (exit 2).
 */

import { realpathSync } from "node:fs";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createEngine } from "./engine.ts";
import { runList } from "./list.ts";
import { resolvePrompt, runHeadless } from "./run.ts";

/** Documented verbs that belong to later slices — recognized but not built here. */
const STUB_VERBS = new Set(["new", "logs", "merge", "rm", "gc", "reap", "engine"]);

/** Parsed `run` headless options. Captures the whole flag surface; the
 * dispatcher forwards only the fields the `runHeadless` entrypoint supports
 * today (model flags / idle-timeout / adapter-args are wired to the real
 * adapters in a later slice). */
export type HeadlessArgs = {
  prompt?: string;
  promptFile?: string;
  branch?: string;
  base?: string;
  name?: string;
  adapter: string;
  claudeModel?: string;
  ampModel?: string;
  wait: boolean;
  json: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  adapterArgs: string[];
};

/** The pure result of parsing argv — a plan the dispatcher executes. */
export type CliResult =
  | { kind: "run-headless"; run: HeadlessArgs }
  | { kind: "run-interactive"; branch: string }
  | { kind: "ls"; json: boolean; all: boolean }
  | { kind: "stub"; verb: string }
  | { kind: "help"; verb?: string }
  | { kind: "error"; message: string };

const RUN_OPTIONS = {
  prompt: { type: "string" },
  "prompt-file": { type: "string" },
  base: { type: "string" },
  name: { type: "string" },
  agent: { type: "string" },
  "claude-model": { type: "string" },
  "amp-model": { type: "string" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  "idle-timeout": { type: "string" },
  json: { type: "boolean" },
  "adapter-arg": { type: "string", multiple: true },
  help: { type: "boolean" },
} as const;

const LS_OPTIONS = {
  json: { type: "boolean" },
  all: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a duration like `500ms`, `30s`, `5m`, `1h` (bare number ⇒ ms) into
 * milliseconds. Throws on malformed input (caught as an operational error).
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(input.trim());
  if (!match) throw new Error(`invalid duration '${input}'`);
  const value = Number(match[1]);
  switch (match[2]) {
    case undefined:
    case "ms":
      return Math.round(value);
    case "s":
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    case "h":
      return Math.round(value * 3_600_000);
    default:
      throw new Error(`invalid duration '${input}'`);
  }
}

/** Parse argv (everything after `agetree`) into a dispatch plan. Pure. */
export function parseCli(argv: string[]): CliResult {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h") {
    return { kind: "help" };
  }
  if (verb === "run") return parseRun(rest);
  if (verb === "ls") return parseLs(rest);
  if (STUB_VERBS.has(verb)) return { kind: "stub", verb };
  return { kind: "error", message: `unknown command '${verb}'\n\n${USAGE}` };
}

function parseRun(rest: string[]): CliResult {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: RUN_OPTIONS,
    }));
  } catch (error) {
    return { kind: "error", message: msgOf(error) };
  }

  if (values.help) return { kind: "help", verb: "run" };

  const prompt = values.prompt as string | undefined;
  const promptFile = values["prompt-file"] as string | undefined;
  if (prompt !== undefined && promptFile !== undefined) {
    return { kind: "error", message: "--prompt and --prompt-file are mutually exclusive" };
  }

  const branch = positionals[0];
  const base = (values.base as string | undefined) ?? positionals[1];

  // Prompt presence is the mode switch (cli-surface). No prompt ⇒ interactive
  // engine passthrough, which needs a branch to run.
  if (prompt === undefined && promptFile === undefined) {
    if (branch === undefined) {
      return {
        kind: "error",
        message: "run requires a branch (interactive) or --prompt/--prompt-file (headless)",
      };
    }
    return { kind: "run-interactive", branch };
  }

  let timeoutMs: number | undefined;
  let idleTimeoutMs: number | undefined;
  try {
    if (values.timeout !== undefined) timeoutMs = parseDuration(values.timeout as string);
    if (values["idle-timeout"] !== undefined) {
      idleTimeoutMs = parseDuration(values["idle-timeout"] as string);
    }
  } catch (error) {
    return { kind: "error", message: msgOf(error) };
  }

  return {
    kind: "run-headless",
    run: {
      prompt,
      promptFile,
      branch,
      base,
      name: values.name as string | undefined,
      adapter: (values.agent as string | undefined) ?? "claude",
      claudeModel: values["claude-model"] as string | undefined,
      ampModel: values["amp-model"] as string | undefined,
      wait: (values.wait as boolean | undefined) ?? false,
      json: (values.json as boolean | undefined) ?? false,
      timeoutMs,
      idleTimeoutMs,
      adapterArgs: (values["adapter-arg"] as string[] | undefined) ?? [],
    },
  };
}

function parseLs(rest: string[]): CliResult {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: LS_OPTIONS,
    }));
  } catch (error) {
    return { kind: "error", message: msgOf(error) };
  }

  if (values.help) return { kind: "help", verb: "ls" };
  if (positionals.length > 0) {
    return { kind: "error", message: `ls takes no positional arguments (got '${positionals[0]}')` };
  }
  // `--all` decision: plain `ls` is the lane-centric view (lanes only); `--all`
  // opts into the full reconciled picture, adding interactive worktrees with no
  // lane record. Maps 1:1 onto listLanes' `all` field.
  return { kind: "ls", json: (values.json as boolean | undefined) ?? false, all: (values.all as boolean | undefined) ?? false };
}

// ── Dispatch ──────────────────────────────────────────────────────────────

export type CliDeps = {
  cwd?: string;
  out?: Writable;
  err?: Writable;
  // Injectable command entrypoints (tests assert forwarding + exit-code passthrough).
  runHeadless?: typeof runHeadless;
  runList?: typeof runList;
  createEngine?: typeof createEngine;
  resolvePrompt?: typeof resolvePrompt;
};

/**
 * Execute a parsed argv against the built commands, returning the process exit
 * code. Exit codes follow `cli-surface`/`result-payload`: the router surfaces
 * whatever exitCode a command returns; operational errors (bad flags, stub
 * verbs) exit 2; help exits 0.
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const result = parseCli(argv);

  switch (result.kind) {
    case "help":
      out.write(helpText(result.verb));
      return 0;
    case "error":
      err.write(`agetree: ${result.message}\n`);
      return 2;
    case "stub":
      err.write(`agetree ${result.verb}: not implemented yet\n`);
      return 2;
    case "ls": {
      const list = deps.runList ?? runList;
      const { exitCode } = await list({
        repoRoot: cwd,
        json: result.json,
        all: result.all,
        out,
        err,
      });
      return exitCode;
    }
    case "run-interactive": {
      const engine = (deps.createEngine ?? createEngine)({ cwd });
      return engine.runInteractive(result.branch);
    }
    case "run-headless": {
      const args = result.run;
      const resolve = deps.resolvePrompt ?? resolvePrompt;
      let prompt: string;
      try {
        prompt = await resolve({ prompt: args.prompt, promptFile: args.promptFile });
      } catch (error) {
        err.write(`agetree: ${msgOf(error)}\n`);
        return 2;
      }
      const run = deps.runHeadless ?? runHeadless;
      const { exitCode } = await run({
        repoRoot: cwd,
        prompt,
        branch: args.branch,
        base: args.base,
        name: args.name,
        adapter: args.adapter,
        wait: args.wait,
        json: args.json,
        timeoutMs: args.timeoutMs,
        out,
        err,
      });
      return exitCode;
    }
  }
}

// ── Help ────────────────────────────────────────────────────────────────────

const USAGE = `usage: agetree <command> [options]

commands:
  run [branch] [base]    start a lane — interactive (no prompt) or headless (--prompt/--prompt-file)
  ls [--json] [--all]    list lanes reconciled against git worktrees
  new logs merge rm gc engine    (not implemented yet)

run 'agetree <command> --help' for command details`;

const RUN_HELP = `usage: agetree run [branch] [base] [options]

  Without a prompt: start the interactive dev stack for <branch> (engine passthrough).
  With a prompt: create/reuse a lane and drive an agent headless in the background.

options:
  --prompt <text>        headless prompt (mutually exclusive with --prompt-file)
  --prompt-file <path>   read the prompt from a file ('-' reads stdin)
  --base <ref>           base branch/ref for the lane (also accepted as positional)
  --name <slug>          influence the auto-generated name when no branch is given
  --agent <name>         adapter to drive the lane (default claude)
  --claude-model <m>     Claude model (namespaced; no portable --model)
  --amp-model <m>        Amp model (namespaced)
  --adapter-arg <arg>    repeatable expert adapter argv addition
  --wait                 block until the lane reaches a terminal status
  --timeout <dur>        max run budget (e.g. 30s, 5m, 1h)
  --idle-timeout <dur>   no-output safety net
  --json                 emit one newline-terminated JSON record on stdout

exit codes: without --wait, 0 = spawned, 2 = operational error.
            with --wait, 0 = done, 1 = terminal non-done, 2 = operational error.`;

const LS_HELP = `usage: agetree ls [--json] [--all]

  List lanes from .agetree/lanes, reconciled against git worktrees.

options:
  --json   print a JSON array of reconciled records (stdout carries only the array)
  --all    also include interactive worktrees that have no lane record

exit codes: 0 normally, 2 on an operational error.`;

function helpText(verb?: string): string {
  if (verb === "run") return `${RUN_HELP}\n`;
  if (verb === "ls") return `${LS_HELP}\n`;
  return `${USAGE}\n`;
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

/** True when this module was invoked directly (bin/agetree → node cli.ts). */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
