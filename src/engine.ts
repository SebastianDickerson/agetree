/**
 * The Engine module — the one-directional TS→Bash seam.
 *
 * TS is the public orchestrator; it shells out to the proven Bash worktree
 * engine (`agent-worktree.sh`) for the lifecycle effects it already does well
 * (create / interactive-run / merge / remove worktrees). Bash stays unaware of
 * `.agetree/` lane state, adapters, and payloads.
 *
 * Rule of the seam: TS never parses Bash's human output as data. Only
 * `ensureWorktree` returns structured data, and it gets that data by re-reading
 * git after calling Bash — never by scraping the script's stdout. The only Bash
 * signal TS consumes is process exit success/failure.
 *
 * See the `ts-bash-boundary` decision in DECISION-MAP.md.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Invoke the Bash engine with an argv array; resolve its exit code. */
export type EngineRunner = (cmd: string, args: string[]) => Promise<number>;

/** Read git worktrees for `cwd` as a map of short branch name → worktree path. */
export type WorktreeReader = (cwd: string) => Promise<Map<string, string>>;

export type Engine = {
  /**
   * Ensure a worktree exists for `branch`, creating it via the engine if
   * absent, and return its canonical branch + path (read from git, not Bash).
   * Throws an operational error if no worktree exists after creation.
   */
  ensureWorktree(branch: string, base?: string): Promise<{ branch: string; path: string }>;
  /** Start the interactive dev stack for `branch` (inherited stdio). */
  runInteractive(branch: string): Promise<number>;
  /** Safe merge-back of `branches` into `target`. */
  merge(
    target: string,
    branches: string[],
    opts?: { all?: boolean; rm?: boolean },
  ): Promise<number>;
  /** Remove a worktree/branch. */
  remove(branch: string, opts?: { force?: boolean }): Promise<number>;
};

export type EngineOptions = {
  /** Path to `agent-worktree.sh`. Defaults to the repo-root copy next to `src/`. */
  enginePath?: string;
  /** Working directory the engine and git run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the process runner (tests inject a spy). */
  run?: EngineRunner;
  /** Override the git worktree reader (tests inject a fake). */
  listWorktrees?: WorktreeReader;
  /**
   * When set, engine stdout+stderr are piped to this sink instead of inherited.
   * The headless `run --prompt` path uses this so engine `new` progress never
   * reaches agetree's stdout (which is reserved for the single JSON object).
   */
  redirectEngineOutput?: Writable;
};

const DEFAULT_ENGINE_PATH = fileURLToPath(new URL("../agent-worktree.sh", import.meta.url));

export function createEngine(options: EngineOptions = {}): Engine {
  const enginePath = options.enginePath ?? DEFAULT_ENGINE_PATH;
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? defaultRunner(enginePath, cwd, options.redirectEngineOutput);
  const listWorktrees = options.listWorktrees ?? defaultWorktreeReader;

  return {
    async ensureWorktree(branch, base) {
      const existing = (await listWorktrees(cwd)).get(branch);
      if (existing) return { branch, path: existing };

      await run(enginePath, base ? ["new", branch, base] : ["new", branch]);

      const path = (await listWorktrees(cwd)).get(branch);
      if (!path) {
        throw new Error(
          `agetree: engine created no worktree for branch '${branch}' (agent-worktree.sh new failed)`,
        );
      }
      return { branch, path };
    },

    runInteractive(branch) {
      return run(enginePath, ["run", branch]);
    },

    merge(target, branches, opts = {}) {
      const args = ["merge", target, ...branches];
      if (opts.all) args.push("--all");
      if (opts.rm) args.push("--rm");
      return run(enginePath, args);
    },

    remove(branch, opts = {}) {
      const args = ["rm", branch];
      if (opts.force) args.push("--force");
      return run(enginePath, args);
    },
  };
}

/**
 * Default runner: spawn the Bash engine, failing fast if it is missing or not
 * executable. Normally uses inherited stdio (so interactive prompts, dev
 * servers, and merge conflicts behave exactly like the script). When a
 * `redirectTo` sink is given (the headless path), stdout+stderr are piped to it
 * instead so nothing leaks to agetree's own stdout.
 */
function defaultRunner(enginePath: string, cwd: string, redirectTo?: Writable): EngineRunner {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      try {
        accessSync(cmd, constants.X_OK);
      } catch {
        reject(new Error(`agetree: engine not found or not executable at ${enginePath}`));
        return;
      }
      const child = spawn(cmd, args, {
        cwd,
        stdio: redirectTo ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      if (redirectTo) {
        child.stdout?.pipe(redirectTo, { end: false });
        child.stderr?.pipe(redirectTo, { end: false });
      }
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
}

/** Parse `git worktree list --porcelain` into short-branch → path. */
export async function defaultWorktreeReader(cwd: string): Promise<Map<string, string>> {
  const raw = await gitPorcelain(cwd);
  const map = new Map<string, string>();
  let path: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && path) {
      const branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      map.set(branch, path);
    } else if (line === "") {
      path = null;
    }
  }
  return map;
}

function gitPorcelain(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["worktree", "list", "--porcelain"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`git worktree list exited ${code}`)),
    );
  });
}
