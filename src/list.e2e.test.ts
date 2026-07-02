import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { listLanes, runList } from "./list.ts";
import { runHeadless } from "./run.ts";

function sh(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" }).trim();
}

function collector(): Writable & { text: string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk;
      cb();
    },
  }) as Writable & { text: string };
  Object.defineProperty(stream, "text", { get: () => text });
  return stream;
}

/** A throwaway repo with a lane worktree (feature-x) plus a bare interactive worktree. */
function freshRepo(): { repo: string } {
  const repo = mkdtempSync(join(tmpdir(), "agetree-ls-"));
  sh(repo, ["git", "init", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Agetree Test"]);
  sh(repo, ["git", "commit", "--allow-empty", "-m", "base"]);
  sh(repo, ["git", "worktree", "add", `${repo}-wt`, "-b", "agetree/feature-x", "main"]);
  // A second worktree with no lane record → interactive.
  sh(repo, ["git", "worktree", "add", `${repo}-ui`, "-b", "ui-polish", "main"]);
  return { repo };
}

describe("agetree ls (end-to-end: real supervisor + real git/dir readers)", () => {
  it("lists a completed lane as done and the bare worktree as interactive", async () => {
    const { repo } = freshRepo();
    const spec = {
      finalMessage: "implemented feature x",
      writeFiles: [{ path: "src/feature.txt", content: "hi\n" }],
    };
    const out = collector();
    const err = collector();

    const run = await runHeadless({
      repoRoot: repo,
      prompt: "implement feature x",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: true,
      json: true,
      supervisorEnv: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      out,
      err,
    });
    expect(run.exitCode).toBe(0);

    // listLanes with the real defaultWorktreeReader + listLaneNames.
    const views = await listLanes({ repoRoot: repo });

    const lane = views.find((v) => v.kind === "lane");
    expect(lane).toBeDefined();
    if (lane?.kind === "lane") {
      expect(lane.record.name).toBe("feature-x");
      expect(lane.record.status).toBe("done");
      expect(lane.orphaned).toBe(false);
    }

    // The bare worktree (and the main checkout) have no lane record → interactive.
    const interactiveBranches = views
      .filter((v) => v.kind === "interactive")
      .map((v) => (v.kind === "interactive" ? v.branch : ""));
    expect(interactiveBranches).toContain("ui-polish");
  });

  it("runList --json prints a JSON array containing the lane, stdout JSON-only", async () => {
    const { repo } = freshRepo();
    const out = collector();
    const err = collector();
    await runHeadless({
      repoRoot: repo,
      prompt: "x",
      branch: "agetree/feature-x",
      base: "main",
      adapter: "fake",
      wait: true,
      json: true,
      supervisorEnv: {
        AGETREE_FAKE_SPEC: JSON.stringify({ finalMessage: "ok", writeFiles: [] }),
      },
      out: collector(),
      err: collector(),
    });

    const res = await runList({ repoRoot: repo, json: true, out, err });

    expect(res.exitCode).toBe(0);
    const arr = JSON.parse(out.text);
    expect(Array.isArray(arr)).toBe(true);
    const names = arr.map((r: { name: string }) => r.name);
    expect(names).toContain("feature-x");
    expect(arr.every((r: Record<string, unknown>) => !("supervisorPid" in r))).toBe(true);
  });
});
