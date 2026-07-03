import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { LaneRecord } from "./lane-state.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agetree");

function sh(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** Run agetree, feeding stdin (the engine's `rm` prompts "delete the branch too?"). */
function agetree(repo: string, args: string[], input = "") {
  return spawnSync(BIN, args, { cwd: repo, encoding: "utf8", input, env: { ...process.env } });
}

function seedLane(repo: string, record: LaneRecord): void {
  const lanesDir = join(repo, ".agetree", "lanes");
  const logsDir = join(repo, ".agetree", "logs");
  mkdirSync(lanesDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(lanesDir, `${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(logsDir, `${record.name}.log`), `log for ${record.name}\n`);
}

function recordPath(repo: string, name: string): string {
  return join(repo, ".agetree", "lanes", `${name}.json`);
}
function logPath(repo: string, name: string): string {
  return join(repo, ".agetree", "logs", `${name}.log`);
}

function doneRecord(name: string, branch: string): LaneRecord {
  return {
    name,
    branch,
    adapter: "fake",
    prompt: "do x",
    supervisorPid: 999_999,
    supervisorStartedAt: 1_000,
    status: "done",
    startedAt: 2_000,
    endedAt: 3_000,
    logPath: `.agetree/logs/${name}.log`,
    payload: { exitCode: 0, isError: false, finalMessage: "done" },
  };
}

/** A throwaway repo with a lane worktree + a matching lane record. */
function seededRepo(): { repo: string; worktree: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-rm-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  const worktree = `${repo}-wt`;
  sh(repo, ["git", "worktree", "add", worktree, "-b", "agetree/feature-x", "main"]);
  seedLane(repo, doneRecord("feature-x", "agetree/feature-x"));
  return { repo, worktree };
}

describe("agetree rm (end-to-end: the built binary as a subprocess)", () => {
  it("removes the worktree + branch and prunes the lane record; ls is then empty", () => {
    const { repo, worktree } = seededRepo();

    // "y" answers the engine's "delete the branch too?" prompt.
    const rm = agetree(repo, ["rm", "feature-x", "--force"], "y\n");
    expect(rm.status).toBe(0);

    // The engine removed the worktree + branch...
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, ["git", "branch", "--list", "agetree/feature-x"])).toBe("");

    // ...and the lane's .agetree/ artifacts were pruned (worktree verifiably gone).
    expect(existsSync(recordPath(repo, "feature-x"))).toBe(false);
    expect(existsSync(logPath(repo, "feature-x"))).toBe(false);

    const ls = agetree(repo, ["ls", "--json"]);
    expect(ls.status).toBe(0);
    expect(JSON.parse(ls.stdout)).toEqual([]);
  });

  it("preserves the engine's exit code when the worktree does not exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "agetree-rm-none-"));
    sh(repo, ["git", "init", "-b", "main"]);
    sh(repo, ["git", "config", "user.email", "test@example.com"]);
    sh(repo, ["git", "config", "user.name", "Agetree Test"]);
    sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);

    // No worktree/record for this branch — the engine's rm reports failure (exit 1),
    // which agetree surfaces verbatim (not remapped to 2).
    const rm = agetree(repo, ["rm", "agetree/nope"]);
    expect(rm.status).toBe(1);
  });
});
