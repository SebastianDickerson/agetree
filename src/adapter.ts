/**
 * The adapter seam. Only two things vary per agent CLI: how the argv is built
 * (`buildCommand`) and how its stdout is turned into a `LaneResult` (`parse`).
 * Everything else — spawning, capture, waiting for exit — is shared in
 * `runLane`, so each adapter stays tiny.
 *
 * Verified against real runs of Claude Code and Amp in `spike/agent-adapter/`
 * and written up in `docs/adapters.md`.
 */

import { spawn } from "node:child_process";

/** What a lane needs to know to drive an agent. */
export type RunOptions = {
  cwd: string;
  prompt: string;
  /** Real coding lanes need this (permission bypass); trivial demos do not. */
  allowAllTools: boolean;
  model?: string;
};

/** A plain argv (+ env) so a future container executor can wrap it untouched. */
export type SpawnSpec = {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

/** The raw process outcome an adapter parses. */
export type RawExit = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** The normalized outcome of a headless agent run. */
export type LaneResult = {
  adapter: string;
  /** The agent's last message — always emitted whole. */
  finalMessage: string;
  exitCode: number;
  /** Diagnostic only: `exitCode !== 0 || result.is_error`. Never the success signal. */
  isError: boolean;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  /** Claude only; omitted for adapters that report no cost. */
  costUsd?: number;
};

export interface Adapter {
  readonly name: string;
  buildCommand(opts: RunOptions): SpawnSpec;
  parse(raw: RawExit): LaneResult;
}

/**
 * Spawn the agent CLI, capture stdout/stderr, wait for the process to exit
 * (completion == process exit for the supported CLIs), then hand the raw exit
 * to the adapter to normalize into a `LaneResult`.
 */
export function runLane(adapter: Adapter, opts: RunOptions): Promise<LaneResult> {
  const { cmd, args, env } = adapter.buildCommand(opts);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(adapter.parse({ stdout, stderr, exitCode: code ?? -1 }));
      } catch (e) {
        reject(
          new Error(
            `${adapter.name} parse failed (exit ${code}): ${e}\nstderr: ${stderr}\nstdout: ${stdout}`,
          ),
        );
      }
    });
  });
}
