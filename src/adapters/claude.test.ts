import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "./claude.ts";

// Captured `--output-format json` stdout shapes (trimmed to the fields we use),
// mirroring docs/adapters.md and the agent-adapter spike's real runs.
const SUCCESS_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "PONG",
  num_turns: 1,
  session_id: "4a67-abc",
  duration_ms: 277051,
  total_cost_usd: 0.0322,
  usage: { input_tokens: 4572, output_tokens: 5 },
});

// Claude sets is_error:true (still-parseable JSON) on API errors, e.g. a bad model.
const API_ERROR_JSON = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "model not found",
  api_error_status: 404,
  num_turns: 1,
  session_id: "err-1",
  duration_ms: 120,
  total_cost_usd: 0,
});

// A result object with no cost field (the Amp-shaped core; also possible if a
// future Claude payload omits it) — proves omit-don't-null.
const NO_COST_JSON = JSON.stringify({
  type: "result",
  is_error: false,
  result: "done",
  num_turns: 2,
  session_id: "no-cost",
  duration_ms: 50,
});

describe("createClaudeAdapter — buildCommand", () => {
  const adapter = createClaudeAdapter();

  it("builds the headless argv with permission bypass by default", () => {
    const spec = adapter.buildCommand({
      cwd: "/lane",
      prompt: "do the thing",
      allowAllTools: true,
    });
    expect(spec.cmd).toBe("claude");
    expect(spec.args).toEqual([
      "-p",
      "do the thing",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  it("omits --dangerously-skip-permissions when allowAllTools is false", () => {
    const spec = adapter.buildCommand({
      cwd: "/lane",
      prompt: "hi",
      allowAllTools: false,
    });
    expect(spec.args).toEqual(["-p", "hi", "--output-format", "json"]);
  });

  it("appends --model <m> when a model is set", () => {
    const spec = adapter.buildCommand({
      cwd: "/lane",
      prompt: "hi",
      allowAllTools: true,
      model: "sonnet",
    });
    expect(spec.args).toEqual([
      "-p",
      "hi",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
    ]);
  });

  it("forwards opts.env (AGETREE_DEPTH etc.) onto the SpawnSpec", () => {
    const spec = adapter.buildCommand({
      cwd: "/lane",
      prompt: "hi",
      allowAllTools: true,
      env: { AGETREE_DEPTH: "1" },
    });
    expect(spec.env).toEqual({ AGETREE_DEPTH: "1" });
  });
});

describe("createClaudeAdapter — parse", () => {
  const adapter = createClaudeAdapter();

  it("extracts the final message + metadata from a success result", () => {
    const result = adapter.parse({ stdout: SUCCESS_JSON, stderr: "", exitCode: 0 });
    expect(result).toEqual({
      adapter: "claude",
      finalMessage: "PONG",
      exitCode: 0,
      isError: false,
      sessionId: "4a67-abc",
      numTurns: 1,
      durationMs: 277051,
      costUsd: 0.0322,
    });
  });

  it("flags isError when the JSON says is_error:true (even on a zero exit)", () => {
    const result = adapter.parse({ stdout: API_ERROR_JSON, stderr: "", exitCode: 0 });
    expect(result.isError).toBe(true);
    expect(result.finalMessage).toBe("model not found");
  });

  it("flags isError when the process exit code is nonzero", () => {
    const result = adapter.parse({ stdout: SUCCESS_JSON, stderr: "", exitCode: 1 });
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("includes costUsd when present", () => {
    const result = adapter.parse({ stdout: SUCCESS_JSON, stderr: "", exitCode: 0 });
    expect(result.costUsd).toBe(0.0322);
  });

  it("omits costUsd (never null) when the result has no cost", () => {
    const result = adapter.parse({ stdout: NO_COST_JSON, stderr: "", exitCode: 0 });
    expect(result).not.toHaveProperty("costUsd");
    expect(result.finalMessage).toBe("done");
  });
});
