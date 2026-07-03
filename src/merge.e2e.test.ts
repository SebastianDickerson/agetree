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

function agetree(repo: string, args: string[]) {
  return spawnSync(BIN, args, { cwd: repo, encoding: "utf8", env: { ...process.env } });
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

describe("agetree merge (end-to-end: the built binary as a subprocess)", () => {
  it("merges a lane into main with --rm: worktree removed + lane record pruned", () => {
    const repo = mkdtempSync(join(tmpdir(), "agetree-merge-"));
    sh(repo, ["git", "init", "-b", "main"]);
    sh(repo, ["git", "config", "user.email", "test@example.com"]);
    sh(repo, ["git", "config", "user.name", "Agetree Test"]);
    // Ignore .agetree/ so the seeded lane state doesn't make the main checkout
    // "dirty" (merge refuses to run against an unclean main).
    writeFileSync(join(repo, ".gitignore"), ".agetree/\n");
    sh(repo, ["git", "add", ".gitignore"]);
    sh(repo, ["git", "commit", "-m", "base"]);

    // A worktree with a real, committed change to merge back.
    const worktree = `${repo}-a`;
    sh(repo, ["git", "worktree", "add", worktree, "-b", "agetree/feat-a", "main"]);
    writeFileSync(join(worktree, "feat.txt"), "feature a\n");
    sh(worktree, ["git", "add", "feat.txt"]);
    sh(worktree, ["git", "commit", "-m", "feat a"]);

    seedLane(repo, doneRecord("feat-a", "agetree/feat-a"));

    const merge = agetree(repo, ["merge", "main", "feat-a", "--rm"]);
    expect(merge.status).toBe(0);

    // The change landed on main, the worktree is gone, and the record was pruned.
    expect(existsSync(join(repo, "feat.txt"))).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(recordPath(repo, "feat-a"))).toBe(false);
  });
});
