# Adapters — Headless Invocation of Coding CLIs

How agetree drives a coding agent **headless** (no human at the keyboard): the exact
invocation, how the prompt goes in, how the final message + a structured payload come out,
how errors surface, and the minimal `Adapter` seam both Claude Code and Amp satisfy.

Everything below is backed by real runs on this machine
(`claude` 2.1.198, `amp` 0.0.1782641874). The throwaway proof lives in
[`spike/agent-adapter/adapter-spike.ts`](../spike/agent-adapter/adapter-spike.ts):

```bash
node --experimental-strip-types spike/agent-adapter/adapter-spike.ts          # PONG, no tools
node --experimental-strip-types spike/agent-adapter/adapter-spike.ts --tools  # autonomous file write
```

---

## The happy path, per CLI

### Claude Code

```bash
claude -p "<prompt>" --output-format json --dangerously-skip-permissions [--model sonnet]
```

- **Non-interactive mode**: `-p` / `--print`. Also skips the workspace-trust dialog.
- **Prompt**: positional arg **or** stdin (`echo "..." | claude -p`). Both verified.
- **Output**: `--output-format` is `text` (default), `json` (single object), or
  `stream-json` (JSONL — **requires `--verbose`** in print mode).
- **Final message**: `text` mode prints only the final message to stdout. `json` mode
  puts it in `.result`.
- **Permissions (required for autonomous tool use)**: `--dangerously-skip-permissions`
  (CLI flag). Granular alternative: `--allowedTools` / `--permission-mode`.

`--output-format json` stdout (trimmed to the fields we use):

```json
{
  "type": "result", "subtype": "success",
  "is_error": false, "result": "PONG",
  "num_turns": 1, "session_id": "4a67...", "duration_ms": 277051,
  "total_cost_usd": 0.0322,
  "usage": { "input_tokens": 4572, "output_tokens": 5 },
  "modelUsage": { "...": {} }
}
```

### Amp

```bash
amp -x "<prompt>" --stream-json [--settings-file <file with amp.dangerouslyAllowAll:true>]
```

- **Non-interactive mode**: `-x` / `--execute`. Auto-enabled when stdout is redirected
  (`amp < prompt.txt > out.txt`).
- **Prompt**: positional arg **or** stdin (`echo "..." | amp -x`). Both verified.
- **Output**: plain text by default (**only the last assistant message** is printed).
  `--stream-json` emits Claude-Code-compatible JSONL; `--stream-json-thinking` adds
  thinking blocks.
- **Final message**: text mode prints only the final message. `--stream-json`'s **last
  line** is a `type:"result"` object with `.result`.
- **Permissions (required for autonomous tool use)**: no CLI flag — set
  `"amp.dangerouslyAllowAll": true` in a settings file and pass `--settings-file`
  (or `AMP_SETTINGS_FILE`). Granular alternative: `amp.permissions`.

`--stream-json` final line (same core shape as Claude):

```json
{ "type": "result", "subtype": "success", "is_error": false, "result": "PONG",
  "num_turns": 1, "session_id": "T-019f...", "duration_ms": 4474 }
```

---

## The key finding: the shapes already match

Both CLIs terminate their JSON output with an identical `type:"result"` record carrying
`is_error`, `result`, `num_turns`, `session_id`, `duration_ms`. Claude additionally
reports `total_cost_usd` and `usage`/`modelUsage`. So the normalized payload is just
"the result object, minus the fields only one side has."

| Concern            | Claude Code                              | Amp                                         |
| ------------------ | ---------------------------------------- | ------------------------------------------- |
| Non-interactive    | `-p` / `--print`                         | `-x` / `--execute` (auto on stdout redirect)|
| Prompt in          | arg or stdin                             | arg or stdin                                |
| Structured out     | `--output-format json` (one object)      | `--stream-json` (last line = result)        |
| Final message      | text: stdout · json: `.result`           | text: stdout · json: last `.result`         |
| Skip permissions   | `--dangerously-skip-permissions` (flag)  | `amp.dangerouslyAllowAll` in settings file  |
| Model selection    | `--model <alias|name>`                   | `-m/--mode {deep,rush,smart}`               |
| Cost reporting     | `total_cost_usd`, `usage`, `modelUsage`  | not emitted                                 |
| Process exits?     | yes                                      | yes                                         |
| Error signal       | exit≠0 **and** `is_error:true`           | exit≠0 (+ stderr; bad flags print no JSON)  |

### Verified behaviours

- **Clean exit**: both return exit `0` and a well-formed result on success.
- **Autonomous tool use** (`--tools` spike): Claude with
  `--dangerously-skip-permissions` and Amp with the `dangerouslyAllowAll` settings file
  each created a file with no prompt, exit `0`.
- **Errors**: Claude with a bad `--model` → exit `1` **and** a JSON result with
  `is_error:true, api_error_status:404` (payload still parseable). Amp with an unknown
  flag → exit `1`, message on **stderr**, no stdout JSON. Lesson: don't rely on a JSON
  result always existing on failure — treat a nonzero exit as authoritative, parse JSON
  when present, fall back to stderr.
- **Speed caveat**: Claude's default model was very slow / multi-turn for even a trivial
  prompt (100s+; `num_turns` > 1). Headless lanes should pin a fast `--model` (e.g.
  `sonnet`/`haiku`). Amp returned in single-digit seconds.

---

## The minimal `Adapter` seam

Only two things vary per CLI: **how you build the argv** and **how you read the result
out of stdout**. Spawning, capture, and the exit-wait are shared, so the adapter stays
tiny (a large behaviour — "run an agent to completion and normalize its output" — behind
a small interface).

```ts
interface Adapter {
  readonly name: string;
  buildCommand(opts: RunOptions): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };
  parse(raw: { stdout: string; stderr: string; exitCode: number }): LaneResult;
}

type RunOptions = {
  cwd: string;            // the lane's worktree
  prompt: string;
  allowAllTools: boolean; // headless coding lanes: true
  model?: string;
};

type LaneResult = {
  adapter: string;
  finalMessage: string;   // Claude .result / Amp last-line .result / text-mode stdout
  exitCode: number;
  isError: boolean;       // exitCode !== 0 || result.is_error
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;       // Claude only
};
```

The shared `runLane(adapter, opts)` spawns the CLI, buffers stdout/stderr, waits for the
process to **close** (completion == exit for both CLIs), then calls `adapter.parse`. See
the spike for the concrete `claudeAdapter` / `ampAdapter` implementations.

### Why this shape

- **Deep, small surface.** Callers say "run this prompt, give me the result." The two
  seam methods are the only per-CLI code; the lifecycle lives once in `runLane`.
- **Container-ready later** (isolation is v1 worktree-only): `buildCommand` returns a
  plain argv, so a future executor can wrap it (`docker run … <cmd> <args>`) without the
  adapters changing.
- **Two real adapters, so the seam is real** (not hypothetical): Claude and Amp exercise
  every field, including the cost-present-vs-absent difference.

---

## Open questions this hands off

- **result-payload** (blocked-by: agent-adapter): `LaneResult` above is the raw material.
  That ticket decides the final field set + when JSON vs human output is emitted, and
  should add `commit sha` / `files changed` (from the auto-commit step, not the adapter).
- **lane-state**: `runLane` is synchronous-await here; background execution needs the PID
  + log-file capture wired into the state dir. The spawn/capture code is the seed.
- **cli-surface**: `--model` (Claude) vs `-m/--mode` (Amp) don't map 1:1 — the CLI needs
  a policy for how (or whether) to expose model selection across adapters.
