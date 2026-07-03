import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Adapter, LaneResult } from "./adapter.ts";
import { runLane } from "./adapter.ts";
import { statePaths, writeLaneRecordAtomic } from "./lane-store.ts";
import {
  agentExit,
  spawnRecord,
  type CommitPayload,
  type FilesChanged,
  type LaneRecord,
} from "./lane-state.ts";

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { pid?: number; unref(): void };

export type DetachedSupervisorOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn?: SpawnProcess;
};

export type RunSupervisorOptions = {
  repoRoot: string;
  worktreePath: string;
  name: string;
  branch: string;
  baseRef: string;
  prompt: string;
  adapter: Adapter;
  /** Adapter model selection (e.g. from `--claude-model`), forwarded to `runLane`. */
  model?: string;
  parentEnv?: NodeJS.ProcessEnv;
  supervisorPid?: number;
  supervisorStartedAt?: number;
  now?: () => number;
  commitMessage?: string;
};

type GitResult = { exitCode: number; stdout: string; stderr: string };

const FILE_LIST_LIMIT = 50;

export function spawnDetachedSupervisor(opts: DetachedSupervisorOptions): number {
  const spawn = opts.spawn ?? nodeSpawn;
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? -1;
}

export function nextAgetreeDepth(env: NodeJS.ProcessEnv = process.env): string {
  const parent = Number.parseInt(env.AGETREE_DEPTH ?? "0", 10);
  return String((Number.isFinite(parent) ? parent : 0) + 1);
}

export async function runLaneSupervisor(opts: RunSupervisorOptions): Promise<LaneRecord> {
  const now = opts.now ?? Date.now;
  const paths = statePaths(opts.repoRoot, opts.name);
  mkdirSync(paths.logsDir, { recursive: true });
  ensureAgetreeExcluded(opts.repoRoot);

  const startedAt = now();
  const running = spawnRecord({
    name: opts.name,
    branch: opts.branch,
    adapter: opts.adapter.name,
    prompt: opts.prompt,
    supervisorPid: opts.supervisorPid ?? process.pid,
    supervisorStartedAt: opts.supervisorStartedAt ?? startedAt,
    startedAt,
    logPath: paths.relativeLogPath,
  });
  writeLaneRecordAtomic(opts.repoRoot, running);

  // Logs can contain secrets/prompts — keep them owner-only.
  const log = createWriteStream(paths.logPath, { flags: "a", mode: 0o600 });
  let result: LaneResult;
  try {
    result = await runLane(opts.adapter, {
      cwd: opts.worktreePath,
      prompt: opts.prompt,
      allowAllTools: true,
      model: opts.model,
      env: { AGETREE_DEPTH: nextAgetreeDepth(opts.parentEnv) },
      log,
    });
  } finally {
    await new Promise<void>((resolve) => log.end(resolve));
  }

  // The supervisor must ALWAYS reach a terminal record. If git bookkeeping
  // (files-changed / merge-base / auto-commit) throws after the agent ran,
  // mark the lane failed with a reason and keep the dirty worktree, rather
  // than rejecting and leaving a stuck `running` record.
  let filesChanged: FilesChanged = { count: 0, files: [], truncated: false };
  let commit: CommitPayload;
  let reason: string | undefined;
  try {
    filesChanged = await readFilesChanged(opts.worktreePath);
    commit = await applyCommitPolicy(opts, result, filesChanged);
    reason = commit.outcome === "error" ? "auto-commit failed" : undefined;
  } catch (error) {
    commit = { outcome: "error" };
    reason = `auto-commit bookkeeping failed: ${errorMessage(error)}`;
  }

  const terminal = agentExit(running, {
    now: now(),
    result,
    commit,
    filesChanged,
    reason,
  });
  writeLaneRecordAtomic(opts.repoRoot, terminal);
  return terminal;
}

async function applyCommitPolicy(
  opts: RunSupervisorOptions,
  result: LaneResult,
  filesChanged: FilesChanged,
): Promise<CommitPayload> {
  if (result.exitCode !== 0) return { outcome: "skipped" };

  const headBefore = await gitStdout(opts.worktreePath, ["rev-parse", "HEAD"]);
  if (filesChanged.count === 0) return { outcome: "nothing", sha: headBefore, baseSha: headBefore };

  const baseSha = await gitStdout(opts.worktreePath, ["merge-base", opts.baseRef, "HEAD"]);
  const add = await git(opts.worktreePath, ["add", "-A"]);
  if (add.exitCode !== 0) return { outcome: "error" };

  const commit = await git(opts.worktreePath, [
    "commit",
    "-m",
    opts.commitMessage ?? `agetree: ${firstLine(result.finalMessage) || opts.name}`,
  ]);
  if (commit.exitCode !== 0) return { outcome: "error" };

  const sha = await gitStdout(opts.worktreePath, ["rev-parse", "HEAD"]);
  return { outcome: "committed", sha, baseSha };
}

async function readFilesChanged(cwd: string): Promise<FilesChanged> {
  const raw = await gitStdout(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const files = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      const renameTarget = path.split(" -> ").at(-1);
      return renameTarget ?? path;
    })
    .sort();
  return {
    count: files.length,
    files: files.slice(0, FILE_LIST_LIMIT),
    truncated: files.length > FILE_LIST_LIMIT,
  };
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function ensureAgetreeExcluded(repoRoot: string): void {
  const gitPath = gitStdoutSync(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = isAbsolute(gitPath) ? gitPath : join(repoRoot, gitPath);
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = readFileIfExists(excludePath);
  if (!existing.split("\n").includes(".agetree/")) {
    appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.agetree/\n`);
  }
}

function gitStdoutSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return "";
    throw error;
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
