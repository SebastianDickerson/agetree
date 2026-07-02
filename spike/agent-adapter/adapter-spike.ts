/**
 * THROWAWAY SPIKE — agent-adapter ticket.
 *
 * Question it answers: can one small `Adapter` seam drive BOTH Claude Code and
 * Amp headless, extract the agent's final message + a structured payload, and
 * observe a clean process exit? Backed by a real run of each.
 *
 * Run (zero install, Node >= 22):
 *   node --experimental-strip-types spike/agent-adapter/adapter-spike.ts
 *   node --experimental-strip-types spike/agent-adapter/adapter-spike.ts --tools
 *
 * Delete once the real orchestrator adopts the interface. The verdict lives in
 * ../../docs/adapters.md and the DECISION-MAP agent-adapter answer.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── The seam ────────────────────────────────────────────────────────────────
// The only thing that varies per CLI is (1) how you build the argv and (2) how
// you read the result out of stdout. Everything else — spawning, capture,
// lifecycle — is shared in runLane() so the adapter stays tiny.

type RunOptions = {
  cwd: string;
  prompt: string;
  allowAllTools: boolean; // real coding lanes need this; PONG demo does not
  model?: string;
};

type SpawnSpec = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };

type RawExit = { stdout: string; stderr: string; exitCode: number };

type LaneResult = {
  adapter: string;
  finalMessage: string;
  exitCode: number;
  isError: boolean;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
};

interface Adapter {
  readonly name: string;
  buildCommand(opts: RunOptions): SpawnSpec;
  parse(raw: RawExit): LaneResult;
}

// ── Claude Code adapter ──────────────────────────────────────────────────────
// Headless: `-p` + `--output-format json` → a single result object on stdout,
// even on API errors (is_error:true, and exit code is nonzero too).
const claudeAdapter: Adapter = {
  name: "claude",
  buildCommand({ prompt, allowAllTools, model }) {
    const args = ["-p", prompt, "--output-format", "json"];
    if (allowAllTools) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    return { cmd: "claude", args };
  },
  parse({ stdout, exitCode }) {
    const obj = JSON.parse(stdout);
    return {
      adapter: "claude",
      finalMessage: obj.result ?? "",
      exitCode,
      isError: exitCode !== 0 || obj.is_error === true,
      sessionId: obj.session_id,
      numTurns: obj.num_turns,
      durationMs: obj.duration_ms,
      costUsd: obj.total_cost_usd,
    };
  },
};

// ── Amp adapter ──────────────────────────────────────────────────────────────
// Headless: `-x` + `--stream-json` → JSONL; the LAST line is a `type:"result"`
// object with the SAME core shape as Claude's. Permission bypass is a *setting*
// (no CLI flag), so we write a scratch settings file and point Amp at it.
const ampAdapter: Adapter = {
  name: "amp",
  buildCommand({ prompt, allowAllTools }) {
    const args = ["-x", prompt, "--stream-json"];
    if (allowAllTools) {
      const dir = mkdtempSync(join(tmpdir(), "agetree-amp-"));
      const settings = join(dir, "settings.json");
      writeFileSync(settings, JSON.stringify({ "amp.dangerouslyAllowAll": true }));
      args.unshift("--settings-file", settings);
    }
    return { cmd: "amp", args };
  },
  parse({ stdout, exitCode }) {
    const lines = stdout.trim().split("\n").filter(Boolean);
    let result: any = {};
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "result") result = obj;
      } catch {
        /* non-JSON line, ignore */
      }
    }
    return {
      adapter: "amp",
      finalMessage: result.result ?? "",
      exitCode,
      isError: exitCode !== 0 || result.is_error === true,
      sessionId: result.session_id,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
    };
  },
};

// ── The shared deep function ─────────────────────────────────────────────────
// Spawns the CLI, captures stdout/stderr, waits for the process to EXIT (both
// CLIs exit on completion), then hands the raw exit to the adapter to normalize.
function runLane(adapter: Adapter, opts: RunOptions): Promise<LaneResult> {
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
        reject(new Error(`${adapter.name} parse failed (exit ${code}): ${e}\nstderr: ${stderr}\nstdout: ${stdout}`));
      }
    });
  });
}

// ── Demo: run both through the same interface ────────────────────────────────
async function main() {
  const useTools = process.argv.includes("--tools");
  const prompt = useTools
    ? "Create a file named spike-hello.txt containing exactly: hi-from-agent"
    : "Reply with exactly the word PONG and nothing else.";

  for (const adapter of [claudeAdapter, ampAdapter]) {
    const cwd = mkdtempSync(join(tmpdir(), `agetree-lane-${adapter.name}-`));
    process.stdout.write(`\n=== ${adapter.name} (cwd ${cwd}) ===\n`);
    const started = Date.now();
    const result = await runLane(adapter, { cwd, prompt, allowAllTools: useTools });
    console.log(JSON.stringify({ ...result, wallMs: Date.now() - started }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
