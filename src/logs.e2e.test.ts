import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agetree");

function sh(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** A throwaway repo with the lane worktree already created (ensureWorktree is a no-op). */
function freshRepoWithWorktree(): { repo: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-logs-e2e-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  sh(repo, ["git", "worktree", "add", `${repo}-wt`, "-b", "agetree/feature-x", "main"]);
  return { repo };
}

function agetree(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(BIN, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("agetree logs (end-to-end: the built binary against a real lane log)", () => {
  it("prints a lane's log by name and by branch, and exits 2 for an unknown lane", () => {
    const { repo } = freshRepoWithWorktree();
    const spec = {
      finalMessage: "implemented feature x",
      writeFiles: [{ path: "src/feature.txt", content: "hello from a lane\n" }],
    };

    // Run a real fake-adapter lane to produce .agetree/logs/feature-x.log.
    const run = agetree(
      repo,
      ["run", "agetree/feature-x", "--base", "main", "--agent", "fake", "--wait", "--json", "--prompt", "implement feature x"],
      { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
    );
    expect(run.status).toBe(0);

    // logs <name> prints the log, exit 0, non-empty.
    const byName = agetree(repo, ["logs", "feature-x"]);
    expect(byName.status).toBe(0);
    expect(byName.stdout.length).toBeGreaterThan(0);

    // logs <branch> resolves the same lane → identical output.
    const byBranch = agetree(repo, ["logs", "agetree/feature-x"]);
    expect(byBranch.status).toBe(0);
    expect(byBranch.stdout).toBe(byName.stdout);

    // A bogus identifier is an operational error: exit 2, empty stdout.
    const bogus = agetree(repo, ["logs", "no-such-lane"]);
    expect(bogus.status).toBe(2);
    expect(bogus.stdout).toBe("");
    expect(bogus.stderr).toMatch(/no such lane: no-such-lane/);
  });
});
