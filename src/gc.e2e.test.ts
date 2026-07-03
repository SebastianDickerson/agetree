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

/** Write a lane record + a matching log file under `.agetree/`. */
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

function doneRecord(name: string, endedAt: number): LaneRecord {
  return {
    name,
    branch: `agetree/${name}`,
    adapter: "fake",
    prompt: "do x",
    supervisorPid: 999_999, // long dead, but irrelevant for terminal records
    supervisorStartedAt: endedAt - 2_000,
    status: "done",
    startedAt: endedAt - 1_000,
    endedAt,
    logPath: `.agetree/logs/${name}.log`,
    payload: { exitCode: 0, isError: false, finalMessage: "done" },
  };
}

/**
 * A throwaway repo seeded with three lanes: a terminal+orphaned (no worktree),
 * a recent terminal WITH a worktree, and a `running` lane whose supervisor pid
 * is alive (pid 1) so gc leaves it running.
 */
function seededRepo(): { repo: string; now: number } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-gc-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  // The recent lane keeps its worktree; the orphan + live lanes have none.
  sh(repo, ["git", "worktree", "add", `${repo}-recent`, "-b", "agetree/recent", "main"]);

  const now = Date.now();
  seedLane(repo, doneRecord("orphan", now)); // terminal, no worktree ⇒ orphaned
  seedLane(repo, doneRecord("recent", now)); // terminal, worktree present ⇒ kept
  seedLane(repo, {
    ...doneRecord("live", now),
    status: "running",
    endedAt: undefined,
    supervisorPid: 1, // pid 1 is always alive ⇒ stays running
    payload: null,
  });
  return { repo, now };
}

describe("agetree gc (end-to-end: the built binary as a subprocess)", () => {
  it("--dry-run reports the orphan prune but touches nothing; then gc prunes it and keeps the rest", () => {
    const { repo } = seededRepo();

    // Dry run: report the intended orphan prune, delete nothing.
    const dry = agetree(repo, ["gc", "--dry-run", "--json"]);
    expect(dry.status).toBe(0);
    const drySummary = JSON.parse(dry.stdout);
    expect(drySummary.pruned).toContainEqual({ name: "orphan", reason: "orphaned" });
    expect(existsSync(recordPath(repo, "orphan"))).toBe(true); // untouched
    expect(existsSync(logPath(repo, "orphan"))).toBe(true);

    // Real run: JSON-only stdout, exit 0, orphan pruned, others kept.
    const run = agetree(repo, ["gc", "--json"]);
    expect(run.status).toBe(0);
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
    const summary = JSON.parse(run.stdout);
    expect(summary.pruned).toEqual([{ name: "orphan", reason: "orphaned" }]);

    // Orphan's artifacts are gone; the recent terminal and the live lane remain.
    expect(existsSync(recordPath(repo, "orphan"))).toBe(false);
    expect(existsSync(logPath(repo, "orphan"))).toBe(false);
    expect(existsSync(recordPath(repo, "recent"))).toBe(true);
    expect(existsSync(recordPath(repo, "live"))).toBe(true);

    // The recent lane's worktree is never touched — gc only mutates .agetree/.
    expect(existsSync(`${repo}-recent`)).toBe(true);

    // ls still shows the survivors.
    const ls = agetree(repo, ["ls", "--json"]);
    const names = JSON.parse(ls.stdout).map((r: { name: string }) => r.name);
    expect(names).toContain("recent");
    expect(names).toContain("live");
    expect(names).not.toContain("orphan");
  });

  it("exits 0 with a 'nothing to do' report on a repo with no lanes", () => {
    const repo = mkdtempSync(join(tmpdir(), "agetree-gc-empty-"));
    sh(repo, ["git", "init", "-b", "main"]);
    sh(repo, ["git", "config", "user.email", "test@example.com"]);
    sh(repo, ["git", "config", "user.name", "Agetree Test"]);
    sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);

    const res = agetree(repo, ["gc"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/nothing to do/);
  });
});
