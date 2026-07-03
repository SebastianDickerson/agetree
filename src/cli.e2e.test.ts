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
  const repo = mkdtempSync(join(tmpdir(), "agetree-cli-"));
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

describe("agetree CLI (end-to-end: the built binary as a subprocess)", () => {
  it("run --json is JSON-only on stdout and exits 0; ls --json then lists the lane", () => {
    const { repo } = freshRepoWithWorktree();
    const spec = {
      finalMessage: "implemented feature x",
      writeFiles: [{ path: "src/feature.txt", content: "hello from a lane\n" }],
    };

    const run = agetree(
      repo,
      [
        "run",
        "agetree/feature-x",
        "--base",
        "main",
        "--agent",
        "fake",
        "--wait",
        "--json",
        "--prompt",
        "implement feature x",
      ],
      { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
    );

    expect(run.status).toBe(0);
    // stdout is exactly one newline-terminated JSON object, nothing else.
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
    const payload = JSON.parse(run.stdout);
    expect(payload).toMatchObject({
      name: "feature-x",
      branch: "agetree/feature-x",
      status: "done",
      adapter: "fake",
      payload: { exitCode: 0, finalMessage: "implemented feature x" },
    });
    expect(payload).not.toHaveProperty("supervisorPid");

    // ls --json prints a JSON array that includes the now-done lane.
    const ls = agetree(repo, ["ls", "--json"]);
    expect(ls.status).toBe(0);
    const arr = JSON.parse(ls.stdout);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.map((r: { name: string }) => r.name)).toContain("feature-x");
  });

  it("a stub verb exits 2 with an empty stdout", () => {
    const { repo } = freshRepoWithWorktree();
    const res = agetree(repo, ["engine", "ls"]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/not implemented yet/);
  });
});
