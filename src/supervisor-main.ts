/**
 * The supervisor entrypoint — the program a detached per-lane supervisor runs.
 *
 * `runHeadless` spawns `node <this file>` detached (`spawnDetachedSupervisor`),
 * connecting the two supervisor halves: this process reads its lane config from
 * the environment, reconstructs the agent adapter, and calls
 * `runLaneSupervisor`, which drives the agent, tees to the log, and writes the
 * terminal lane record.
 *
 * Config env vars (all `AGETREE_`-namespaced): REPO_ROOT, WORKTREE, LANE_NAME,
 * BRANCH, BASE (empty ⇒ use the worktree's start HEAD as the range base),
 * PROMPT, ADAPTER (+ FAKE_SPEC for the fake adapter), DEPTH (parent depth,
 * forwarded to the agent as parent+1 by the supervisor).
 */

import { execFileSync } from "node:child_process";
import type { Adapter } from "./adapter.ts";
import { createFakeAdapter } from "./adapters/fake.ts";
import { runLaneSupervisor } from "./supervisor.ts";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`supervisor entrypoint: missing ${key}`);
  return value;
}

function buildAdapter(name: string, env: NodeJS.ProcessEnv): Adapter {
  switch (name) {
    case "fake": {
      const raw = env.AGETREE_FAKE_SPEC;
      return createFakeAdapter(raw ? JSON.parse(raw) : {});
    }
    // The real claude/amp adapters are wired in a later slice.
    default:
      throw new Error(`supervisor entrypoint: unknown adapter '${name}'`);
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const repoRoot = required(env, "AGETREE_REPO_ROOT");
  const worktreePath = required(env, "AGETREE_WORKTREE");
  const name = required(env, "AGETREE_LANE_NAME");
  const branch = required(env, "AGETREE_BRANCH");
  const prompt = env.AGETREE_PROMPT ?? "";
  // With no explicit base, the worktree's HEAD at start is the review-range base.
  const baseRef =
    env.AGETREE_BASE ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  const adapter = buildAdapter(env.AGETREE_ADAPTER ?? "fake", env);

  await runLaneSupervisor({
    repoRoot,
    worktreePath,
    name,
    branch,
    baseRef,
    prompt,
    adapter,
    parentEnv: env,
  });
}

main().catch((error) => {
  process.stderr.write(
    `agetree-supervisor: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
