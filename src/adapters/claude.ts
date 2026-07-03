/**
 * The Claude Code adapter — the first real (non-fake) adapter.
 *
 * Promoted verbatim from the verified `spike/agent-adapter/adapter-spike.ts`
 * proof (see `docs/adapters.md` and the `agent-adapter` decision). Only two
 * things vary per CLI: how the argv is built (`buildCommand`) and how stdout is
 * turned into a `LaneResult` (`parse`); everything else — spawning, capture,
 * exit-wait — is shared in `runLane`.
 *
 * Headless invocation:
 *   claude -p "<prompt>" --output-format json
 *     [--dangerously-skip-permissions] [--model <m>]
 * `--output-format json` prints a single `type:"result"` object on stdout, and
 * still does so on API errors (`is_error:true`, with a nonzero exit too).
 */

import type { Adapter, LaneResult, RawExit, RunOptions } from "../adapter.ts";

/** Build the Claude Code adapter. Model selection is per-run (via `RunOptions`). */
export function createClaudeAdapter(): Adapter {
  return {
    name: "claude",
    buildCommand({ prompt, allowAllTools, model, env }: RunOptions) {
      const args = ["-p", prompt, "--output-format", "json"];
      if (allowAllTools) args.push("--dangerously-skip-permissions");
      if (model) args.push("--model", model);
      // Forward supervisor-injected env (AGETREE_DEPTH etc.) onto the spawn.
      return { cmd: "claude", args, env };
    },
    parse({ stdout, exitCode }: RawExit): LaneResult {
      const obj = JSON.parse(stdout);
      const result: LaneResult = {
        adapter: "claude",
        finalMessage: obj.result ?? "",
        exitCode,
        isError: exitCode !== 0 || obj.is_error === true,
        sessionId: obj.session_id,
        numTurns: obj.num_turns,
        durationMs: obj.duration_ms,
      };
      // Cost is Claude-only: omit the field entirely when absent, never null.
      if (obj.total_cost_usd !== undefined) result.costUsd = obj.total_cost_usd;
      return result;
    },
  };
}
