---
name: delegating-to-lanes
description: Delegating independent, branch-worthy subtasks to background agetree lanes. Use when you are about to fan out N changes that don't depend on each other, run subtasks in parallel, or delegate a self-contained task to a background agent — and to read the JSON result back.
---

A **lane** is a coding agent running headless in its own git worktree. You spawn one with
`agetree run --prompt …`; it runs in the background and ends as a mergeable branch plus a
JSON record. Treat a lane as a **function call**, not a conversation: you hand it a complete
prompt, it returns once, you read the result. That framing decides everything below.

## When to fan out — the "worth it" test

Delegate a subtask only when it is **all four** of:

1. **independent** — no mid-task back-and-forth with you.
2. **self-containable** — you can write a complete prompt a fresh, history-less agent can
   finish (goal, file paths, conventions, definition of done).
3. **branch-worthy** — it yields a mergeable branch, not a one-line answer.
4. **isolated/parallel** — it belongs on its own risky/experimental branch, or is one of
   several such subtasks runnable at once.

**Headline trigger:** *"I'm about to do N independent, branch-worthy changes that don't
depend on each other → fan them out in parallel."*
Secondary: *"this one change is experimental/throwaway → give it its own lane."*

## When NOT to — do it yourself instead

- **Trivial work** — a single read/grep/one-line edit/answer. Lane overhead dwarfs it.
- **Sequential/dependent work** — step B needs step A's in-flight result, or you'll iterate.
  Lanes are function calls, not conversations.
- **Shared-context work** — it depends on uncommitted state or context expensive to
  serialize. A child sees only its fresh worktree + prompt, nothing from your history.
- **Unbounded exploration** — "figure out what to do". Fan out *execution* of a decided
  plan, never the deciding.

**Unifying rule: if writing the self-contained prompt costs more than doing the work, don't
fan out.**

## Guardrails

- **Depth cap 2.** Read `AGETREE_DEPTH` from your environment. If it is `≥ 2`, do the work
  inline — do not spawn. The supervisor injects `parent + 1` into each lane (unset = `0` at
  the human top level), so human `0→1`, child `1→2`, and depth-2 lanes are leaves.
- **Width cap ~5.** Spawn at most ~5 lanes from one agent at once; batch beyond that.
- **Re-fan sparingly.** A child only spawns its own lanes if its subtask genuinely splits
  again.

## Invocation — two recipes

**Prompt authoring is the real skill.** The child has zero conversation history, so every
prompt must be self-contained: goal, relevant file paths, conventions/constraints, and a
crisp definition of done. For long prompts prefer `--prompt-file <path>` (or `-` for stdin).

**Single delegation** (blocking function call) — always `--wait --json`:

```sh
agetree run --agent claude --base main --wait --json --prompt "<self-contained task>"
```

⚠️ `--json` *without* `--wait` returns a `running` record, not a result. For a blocking call
always pair them.

**Parallel fan-out** — a single-threaded agent driving many lanes at once:

1. Spawn each lane **without `--wait`** (with `--json` to capture its `name`). Each returns
   right after spawn with exit `0`.
2. Collect the lane `name`s.
3. **Poll `agetree ls --json`** until every lane's `status` is terminal.
4. Read each lane's final record from the poll.

## Reading the payload — status first

The JSON record is the canonical artifact; the human view is just a projection of it.

1. **Read `status` first — the single success signal.** `done` ⇒ a mergeable branch at
   `payload.commit.sha`. Any other terminal value ⇒ not success; read `payload.reason`.
   **Do not** branch on `exitCode`/`isError` — they are diagnostics only.
2. Then read as needed:
   - `payload.finalMessage` — the answer, always emitted whole (empty when the agent only
     wrote files; lean on `filesChanged` + `logPath`).
   - `payload.filesChanged` — `{count, files, truncated}`. On `truncated:true`, fall back to
     the `baseSha..sha` range.
   - `payload.commit.{sha, baseSha}` — the review/diff handle is `baseSha..sha`.
3. **Rely only on the always-present core:** `name`, `branch`, `status`, `adapter`,
   `payload.exitCode`, `payload.finalMessage`. Everything else is **omit-don't-null** — read
   defensively (e.g. `costUsd` lives at `payload.costUsd`, Claude only).
4. **On failure:** report `reason`; optionally inspect `payload`'s `logPath` or the kept
   dirty worktree. **Do not silently retry in a loop.**

A real `done` record (field names are authoritative):

```json
{"name":"…-mr4c7kw5","branch":"agetree/…-mr4c7kw5","adapter":"claude","status":"done",
 "startedAt":1719900000000,"endedAt":1719900012400,"logPath":".agetree/logs/….log",
 "orphaned":false,
 "payload":{"exitCode":0,"isError":false,
   "finalMessage":"Created `LANE_B.md` …",
   "commit":{"outcome":"committed","sha":"c9c8c7c…","baseSha":"e946620…"},
   "filesChanged":{"count":1,"files":["LANE_B.md"],"truncated":false},
   "sessionId":"…","numTurns":2,"durationMs":11510,"costUsd":0.0989493}}
```

## Merge-back is the integrator's job

**Children return branches, never merge.** A `done` lane's deliverable is a reviewable
branch at `commit.sha`; surface `branch` + `baseSha..sha` range + `finalMessage` upward and
stop there.

Only the **top-level integrator (depth 0)**, when it explicitly owns integration, merges —
after all lanes are `done`, **sequentially, one at a time**, checking each result:

```sh
agetree merge <target> <branch> --rm
```

For cleanup, lean on `merge <target> <branch> --rm` (cleans worktree + branch + record) and
`agetree gc` (prunes orphaned/terminal records). Avoid bare `agetree rm <lane>` for
happy-path cleanup — on a `done` lane the engine's interactive prompt makes it exit non-zero
and leave the branch + an orphaned record behind (which `gc` then reaps).

## Everything else — defer to `--help`

Only the two recipes and the always-present core above are hard-coded here. For the full
flag/verb list (adapters, `--base`, `--timeout`, `--prompt-file`, model flags,
`merge`/`rm`/`logs`), run `agetree run --help` / `agetree --help`.

**The JSON is authoritative over this prose.** If the skill's text and a returned record
ever disagree, trust the record.
