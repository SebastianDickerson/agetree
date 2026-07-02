/**
 * The fake adapter — a deterministic, offline stand-in for a real coding CLI.
 *
 * It is a genuine `Adapter`, so it flows through the real `runLane` spawn/
 * capture/parse path exactly like the Claude and Amp adapters. The difference
 * is that its `buildCommand` runs a scripted fake agent (`fake-agent.mjs`)
 * whose behavior — final message, exit code, files written — is fixed by a
 * spec. This is what lets the CLI-subprocess test seam exercise the whole
 * pipeline (worktree → supervisor → capture → auto-commit → payload) without a
 * live LLM.
 */

import { fileURLToPath } from "node:url";
import type { Adapter, RawExit, RunOptions } from "../adapter.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

/** A file the fake agent should create in the lane worktree. */
export type FakeFile = { path: string; content: string };

/** An environment variable the fake agent should write into a file. */
export type FakeEnvWrite = { name: string; path: string };

/** The scripted behavior of a fake agent run. */
export type FakeAgentSpec = {
  finalMessage?: string;
  exitCode?: number;
  writeFiles?: FakeFile[];
  writeEnv?: FakeEnvWrite[];
  stderr?: string;
  isError?: boolean;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
};

/** Build a fake adapter that runs the scripted agent with the given spec. */
export function createFakeAdapter(spec: FakeAgentSpec = {}): Adapter {
  return {
    name: "fake",
    buildCommand(_opts: RunOptions) {
      return {
        cmd: process.execPath,
        args: [FAKE_AGENT],
        env: { AGETREE_FAKE_SPEC: JSON.stringify(spec) },
      };
    },
    parse({ stdout, exitCode }: RawExit) {
      const obj = JSON.parse(stdout);
      return {
        adapter: "fake",
        finalMessage: obj.result ?? "",
        exitCode,
        isError: exitCode !== 0 || obj.is_error === true,
        sessionId: obj.session_id,
        numTurns: obj.num_turns,
        durationMs: obj.duration_ms,
      };
    },
  };
}
