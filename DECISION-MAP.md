# agetree — Decision Map

A personal orchestrator that grows the `agent-worktree.sh` engine into a sandcastle-style
tool: run coding agents in isolated git worktrees ("lanes"), interactively **or** headless,
then merge their work back safely. Agents themselves can spawn lanes and delegate sub-tasks.

## Notes

- **Domain**: personal agent-worktree orchestrator. Not a distributed product.
- **Consult every session**: `/agent-worktrees` (the worktree engine + its gotchas),
  `/codebase-design` (deep-module vocabulary for seams), plus `/grilling` +
  `/domain-modeling` when a ticket is a Grilling type, `/prototype` for Prototype tickets.
- **Standing prefs**: smallest correct change; reuse the proven Bash worktree engine;
  keep new orchestration in TypeScript; one clean adapter seam per external CLI; don't
  build isolation/MCP/multi-provider machinery before the CLI shape has earned it.

### Glossary (domain model)

- **Lane** — one worktree + its branch + env + assigned port(s). The unit of work.
  A lane is either *interactive* (a human/agent sits in it) or *headless* (agetree
  drives an agent from a prompt).
- **Parent agent / child agent** — a running agent can spawn a headless lane and hand
  it a prompt; the spawner is the parent, the spawned agent is the child. Recursive fan-out.
- **Worktree engine** — the existing `agent-worktree.sh` (new/run/ls/merge/rm + stack
  detection + env/port + safe merge-back). Stays Bash.
- **Orchestrator** — the new TS layer that owns headless invocation, adapters, lane
  state, and the agent-facing interface. Shells out to the worktree engine.
- **Adapter** — a thin per-CLI implementation of "run this agent headless, give me its
  final message + exit code" (Claude Code first-class, Amp second).
- **Payload** — the outcome sub-object of a lane record: what the lane *produced*
  (git facts + the agent's result), as opposed to its identity/lifecycle. The whole
  reconciled record (identity + `payload`) is what `run --wait --json` prints.

---

## RESOLVED (decided during map-building)

- **identity** — A **personal power-tool**, not a shareable product. Optimize for the
  author's workflow; may graduate to open-source later if it earns it.
- **drive-mode** — Lanes support **both** interactive and headless via the *same*
  lifecycle. A lane is a lane; `--prompt` flips it from "I'll drive" to "agetree drives".
- **agent-targets** — **Claude Code first-class**, **Amp supported second**. Implies a
  thin two-implementation adapter seam in v1 (not sandcastle's full provider zoo).
- **runtime** — **Hybrid**: keep the Bash worktree engine as-is; write the new
  orchestration layer in **TypeScript/Node** that shells out to it. May absorb Bash into
  TS later. Young project — design is expected to improve.
- **isolation** — **Worktree-only** for v1. Headless agents run on the host in the
  worktree with the author's permissions. Shape the "run headless" fn so a container
  executor could slot in later; don't build it now.
- **agent-interface** — Parent agents spawn lanes via a **plain CLI subprocess**
  (`agetree run … --prompt …`, works for any agent that can run a shell command) **+ a
  skill** that teaches an agent *when/why* to fan out and how to read the result. MCP is
  a v2 upgrade, not now.
- **execution-model** — **Background by default + `--wait`**. Runs detached and tracked;
  `ls` shows `running/done/failed`; `logs` tails; `--wait` blocks and prints the result
  (function-call semantics for a parent agent). **Completion = process exit** (Claude
  Code / Amp headless both exit when done) + an optional idle/max-time timeout safety net.
- **output-capture** — On **clean exit, auto-commit** the worktree (`agetree: <summary>`)
  so every lane ends as a mergeable branch. On non-zero exit: don't commit, mark `failed`,
  keep the dirty worktree for inspection. Every lane yields a **structured payload**.
- **auto-naming** — Agent-spawned / fan-out lanes that omit a branch name get an
  auto-generated one: `agetree/<slug-of-prompt>-<short-timestamp>` (sandcastle-style).
  Base branch resolution reuses the engine's existing rules.

---

## FRONTIER (open tickets)

## agent-adapter: Nail Headless Invocation For Claude Code (+ Amp)

Blocked by: —
Status: resolved
Type: Research + Prototype

### Question

The core technical unknown. For Claude Code (first) and Amp (second): what is the exact
headless invocation? Which flags give non-interactive/print mode; how is the prompt
passed (arg vs stdin vs file); what does stdout look like (plain text vs stream-json);
how do we extract the **agent's final message**; how do usage/errors surface; does the
process reliably **exit** on completion? Produce a minimal `adapter` interface both CLIs
satisfy, backed by a real run of each. Asset: `docs/adapters.md` + a throwaway spike.

### Answer

Nailed and verified with real runs (`claude` 2.1.198, `amp` 0.0.1782641874). Full
write-up in `docs/adapters.md`; runnable proof in `spike/agent-adapter/adapter-spike.ts`.

- **Invocation** — Claude: `claude -p "<prompt>" --output-format json
  --dangerously-skip-permissions [--model sonnet]`. Amp: `amp -x "<prompt>" --stream-json
  [--settings-file <file with amp.dangerouslyAllowAll:true>]`. Both take the prompt as an
  arg or via stdin. Both reliably **exit** on completion (completion == process exit).
- **Final message + payload** — Both terminate their JSON with an **identical**
  `type:"result"` record: `{is_error, result, num_turns, session_id, duration_ms}`.
  Claude adds `total_cost_usd` + `usage`/`modelUsage`; Amp emits no cost. In plain-text
  mode both print *only* the final message to stdout. Verified autonomous tool use
  (headless file writes) for both with the permission-bypass options above.
- **Errors** — Nonzero exit is authoritative. Claude also sets `is_error:true` in the
  (still-parseable) JSON on API errors; Amp prints CLI errors to **stderr** with no JSON.
- **Permissions asymmetry** — Claude has a CLI flag; Amp only has the
  `amp.dangerouslyAllowAll` *setting*, so agetree writes a scratch settings file and
  passes `--settings-file`.
- **Speed caveat** — Claude's default model was very slow/multi-turn even for trivial
  prompts; headless lanes should pin a fast `--model`. Amp returned in seconds.
- **Seam** — Only two things vary per CLI: **argv construction** and **stdout parsing**.
  A tiny `Adapter { name; buildCommand(opts); parse(raw) → LaneResult }` plus a shared
  `runLane()` (spawn + capture + exit-wait) covers both. `buildCommand` returns a plain
  argv, so a future container executor can wrap it without touching the adapters.
- **Hands off** — `LaneResult` is raw material for **result-payload**; `runLane`'s
  spawn/capture is the seed for **lane-state** (PID + log-file); `--model` vs `-m/--mode`
  is a divergence for **cli-surface** to resolve.

## lane-state: Where Lane Metadata, Status & Logs Live

Blocked by: —
Status: resolved
Type: Prototype

### Question

For background runs we need durable per-lane state: status (`running/done/failed`), PID,
start/end time, prompt, branch, log-file path, and the payload. Where does it live
(`.agetree/lanes/<name>.json`? logs in `.agetree/logs/`?), how does `ls` read it, how is
a detached process tracked and reaped, and how does this coexist with the Bash engine's
own `ls`? Asset: a prototype of the state dir + `ls`/`logs` reading it.

### Answer

Asset: `prototypes/lane-state/` (pure `lane-state.mjs` + throwaway TUI + `NOTES.md`).

- **Storage**: `.agetree/lanes/<name>.json` (one file per lane — no lock contention
  between concurrent supervisors; a crash just leaves a readable JSON) + logs at
  `.agetree/logs/<name>.log`. `ls` = readdir + parse + reconcile. `.agetree/` is hidden
  via the engine's existing `info/exclude` trick, not the tracked `.gitignore`.
  Fields: `name, branch, prompt, supervisorPid, status, startedAt, endedAt, logPath, payload`.
- **State machine**: `running → done/failed` are the *only* authoritative writes, made by
  the supervisor (`spawn` on start, `agentExit` on child exit; idempotent). `stale` and
  `timed-out` are derived at **read time** by `reconcile()`, never written by a supervisor.
- **Reaping (the core answer)**: `agetree run` spawns a **detached per-lane supervisor**
  (`setsid`/`unref`) and returns. The supervisor is the reaper — it writes `running`,
  pipes agent output to the logfile, waits for the agent, then writes the terminal status +
  payload and auto-commits on clean exit. Because the supervisor can itself be killed/rebooted,
  **the reaper needs a reaper**: `reconcile()` reclassifies stuck `running` records at read
  time — dead pid → `stale`, past `maxRunMs` → `timed-out` (CLI also kills it). This is the
  only logic that runs after the spawner is gone, so it lives on the read path.
- **Commit policy**: `exit 0`+committed→`done`; `exit 0`+nothing-to-commit→`done`;
  `exit 0`+commit-error→`failed`; `exit ≠0`→`failed` (dirty worktree kept). `stale`/`timed-out`
  also keep the dirty worktree.
- **`ls` persistence — reads never write**: `reconcile()` is pure classification; who
  *persists* the healed status is the policy call. Decided: **derive on every read, persist
  only from a command that already owns the lifecycle** (`rm`, `merge --rm`, or an explicit
  `gc`/`reap` verb — see `lane-gc`). `ls`/`--wait` display the reconciled status but never
  touch disk. Rationale: a persisting `ls` is the most-run, most-concurrent command, so
  writing from it invites (a) torn JSON from concurrent writers to one lane file, and (b) a
  resurrection race — `ls` reads `running`, sees a dead pid, and clobbers the `done`+payload
  the supervisor wrote in the meantime. It also makes a read fail on a read-only/full disk
  and violates least-astonishment. Pure-derive alone would let a `stale` record lie forever
  on disk (bad for the Bash side / `--json` / a human `cat`), so an owner still self-heals it
  — just at a well-defined moment, not on every glance. Writes must be atomic (temp + rename).
- **Coexistence**: `agetree ls` is lane-centric (`.agetree/lanes/`); `agent-worktree.sh ls` is
  worktree-centric. They key on **branch**. A worktree with no lane record = interactive
  (dimmed); a terminal lane whose worktree was `rm`'d = an `orphan` derived flag.

## result-payload: Exact Shape Of The Payload

Blocked by: agent-adapter
Status: resolved
Type: Grilling

### Question

Define the structured payload a finished lane yields: fields (branch, commit sha(s),
files changed, agent final message, exit code, timings, log path), the machine format
(JSON to stdout when `--wait`/`--json`, human-readable otherwise), and how the parent
agent is expected to consume it. Depends on what each adapter can actually emit.

### Answer

Resolved by grilling. The payload fuses three sources: the lane record (`lane-state`),
the adapter `LaneResult` (`agent-adapter`), and git facts from the auto-commit step.

- **Consumer** — **parent-agent-first**. The JSON object is the canonical artifact
  (function-call semantics for a lane); the human view is a *projection* of it, never a
  separate schema. One source of truth, no drift.
- **One object, two layers** — `run --wait`/`--json` prints the **whole reconciled lane
  record** (not a bespoke envelope). Top-level = **identity/lifecycle**; nested `payload`
  = **outcome** (git facts + agent result). So `cat .agetree/lanes/<name>.json` ≈ what
  `--wait` printed, and there's no parallel shape to keep in sync.
- **Shape**:

  ```jsonc
  {
    "name": "feature-x",              // identity/lifecycle (lane record)
    "branch": "agetree/feature-x",
    "status": "done",                 // done | failed | stale | timed-out | running
    "orphaned": false,                // derived flag (worktree rm'd)
    "adapter": "claude",              // which CLI drove it — promoted to top-level
    "prompt": "…",                    // kept, so a fan-out parent can correlate
    "startedAt": 1719900000000,
    "endedAt":   1719900012400,
    "logPath": ".agetree/logs/feature-x.log",
    "payload": {                      // outcome sub-object
      "exitCode": 0,
      "isError": false,              // exitCode !== 0 || result.is_error — diagnostic only
      "finalMessage": "…",           // agent's last message, ALWAYS emitted whole
      "reason": null,                // short string on every non-`done` status; omitted on done
      "commit": {
        "outcome": "committed",      // committed | nothing | skipped | error
        "sha":     "d4e5f6a",        // branch head after auto-commit
        "baseSha": "a1b2c3d"         // merge-base with base branch → review range baseSha..sha
      },
      "filesChanged": { "count": 3, "files": ["src/a.ts", "…"], "truncated": false },
      "sessionId": "…",              // adapter LaneResult
      "numTurns": 4,
      "durationMs": 12400,
      "costUsd": 0.031               // Claude only; OMITTED for Amp
    }
  }
  ```

  `supervisorPid` stays on disk but is **omitted** from output (internal plumbing).

- **`status` is the single success signal** — `done` ⇒ mergeable branch at `commit.sha`;
  any other terminal status ⇒ not success. `exitCode`/`isError` are demoted to *why*, never
  the branch condition (because `status` encodes the fuller policy: `exit 0 + commit error
  → failed`). `payload.reason` explains every non-`done` outcome in one read (`"agent
  exited 2"`, `"auto-commit failed: …"`, `"supervisor died"`, `"exceeded max run budget"`).
  No separate `ok` boolean.
- **commit sha(s)** — head + `baseSha` range, not a list. `baseSha..sha` is the exact
  review/diff handle whether the agent made zero own commits (just the auto-commit) or
  several; intermediate shas are recoverable via `git log baseSha..sha`. On
  `nothing`, `sha === baseSha`; on `skipped`/`error`, both omitted (dirty worktree kept).
- **filesChanged** — `{ count, files, truncated }`. Precomputed (parent avoids re-shelling
  to git) but capped at **50** paths: `count` is always the true total, `truncated:true`
  when the list was capped (parent falls back to the range). No per-file status/line counts
  in v1 — derivable from the range.
- **finalMessage** — **never truncated in JSON** (it's the answer the parent waited for; only
  the last assistant message, bounded in practice; full transcript at `logPath`). Empty
  string when the agent only wrote files — parent leans on `filesChanged` + `logPath`.
- **Emission contract**:
  - `--json` and `--wait` are **orthogonal**. `--wait --json` → block, print terminal
    record as JSON. `--wait` → block, human projection. `--json` (no wait) → return now,
    print the `running` record as JSON. Neither → human one-liner ("lane started, pid …").
  - **stdout carries only the JSON** (one newline-terminated object); all agetree
    progress/diagnostics go to **stderr**, so a parent pipes stdout straight to a parser.
  - agetree's **own exit code mirrors lane success** under `--wait`: `0` = `done`,
    `1` = non-`done` terminal, `2` = agetree operational error (bad flags/engine failure).
    Without `--wait`, exit `0` just means "spawned OK".
- **Schema stability** — **no `schemaVersion` field** in v1; **additive-only discipline**
  (fields only added, never renamed/removed; skill reads defensively). **Omit-don't-null**
  for inapplicable optional fields (`costUsd` on Amp, `commit.sha`/`baseSha` on
  `skipped`/`error`, `reason` on `done`). Fixed **always-present core** a parent can rely on
  unconditionally: `name, branch, status, adapter, payload.exitCode, payload.finalMessage`.
- **Human projection** (this ticket owns the single-lane `run --wait` view; the `ls` table
  is `cli-surface`/`lane-state`). Pure projection of the JSON — glyph from `status`
  (`✓`/`✗`/`…`), header line, key/value lines, then the whole `finalMessage`:

  ```
  ✓ done  lane feature-x · claude · 12.4s
    branch  agetree/feature-x   (3 files changed)
    range   a1b2c3d..d4e5f6a
    log     .agetree/logs/feature-x.log

    <finalMessage, in full>
  ```

  Failure leads with `reason` and drops the commit/range/files lines. Commit lines shown
  only when `commit.outcome === "committed"`.

- **Hands off** — this locks the JSON contract `cli-surface` must expose (`--json`/`--wait`
  orthogonality, stdout=JSON-only, exit-code 0/1/2) and that `skill-design` teaches a parent
  to read (`status` first, then `finalMessage`/`filesChanged`/`commit`). The persisted
  `payload` blob in `lane-state` should adopt these exact fields (its current placeholder
  is `{exitCode, commit, filesChanged, finalMessage}` — extend with `isError, reason,
  baseSha, filesChanged.{files,truncated}` and the adapter metadata). `filesChanged` +
  `baseSha` are computed by the auto-commit step, not the adapter.

## cli-surface: Command & Flag Design

Blocked by: agent-adapter, lane-state, result-payload
Status: resolved
Type: Grilling

### Question

Design the `agetree` command surface and how it composes with the engine's existing
`new/run/ls/merge/rm`. What are the verbs (`run`, maybe `spawn`), the flags
(`--prompt`, `--prompt-file`, `--wait`, `--json`, base branch, timeout), and the naming
so it's ergonomic both for a human fanning out and for a parent agent shelling out?
Consider `/design-an-interface` to sketch 2–3 shapes before committing.

### Answer

Resolved as a **compatibility-first façade** over the proven Bash engine. Keep
`new/run/ls/merge/rm` as public `agetree` verbs so migration from `agent-worktree.sh` is
mostly a command-name swap, and use prompt presence as the disambiguator:
`agetree run <branch>` without a prompt keeps the engine's interactive dev-stack behavior;
`agetree run [branch] --prompt ...` is the new headless orchestrator path for parent agents.

### Command list

- `agetree new <branch> [base]` — create an interactive lane/worktree by delegating to
  `agent-worktree.sh new <branch> [base]`. No agent is started.
- `agetree run <branch>` — compatibility mode for `agent-worktree.sh run <branch>`: start the
  interactive dev stack for an existing lane/worktree.
- `agetree run [branch] [base] --prompt <text>` — headless orchestrator mode: create/reuse a
  lane, start the selected agent adapter in the background, write state under
  `.agetree/lanes`, stream logs under `.agetree/logs`, and auto-commit on clean exit. If
  `branch` is omitted, auto-name as `agetree/<slug-of-prompt>-<short-timestamp>`.
- `agetree run [branch] [base] --prompt-file <path>` — same as `--prompt`, but reads the
  prompt from a file (`-` means stdin). Exactly one of `--prompt` / `--prompt-file` selects
  headless mode.
- `agetree ls [--json] [--all]` — lane-centric list from `.agetree/lanes`, reconciled with
  worktrees. Includes interactive worktrees with no lane record and marks orphaned terminal
  records. `--json` prints an array of reconciled records.
- `agetree logs <branch-or-lane> [-f|--follow] [--lines <n>]` — print/tail
  `.agetree/logs/<name>.log`.
- `agetree merge <target> [branches...] [--all] [--rm]` — delegate merge-back to the Bash
  engine, accepting lane names or branch names. `--rm` removes successfully merged worktrees;
  lane-record/log pruning details remain for `lane-gc`.
- `agetree rm <branch-or-lane> [--force]` — remove a lane/worktree by delegating to the Bash
  engine. State/log cleanup policy remains owned by `lane-gc`.
- `agetree gc` / `agetree reap` — lifecycle-owner hook for the `lane-gc` ticket to persist
  healed `stale`/`timed-out` statuses, kill timed-out processes, and prune old terminal lane
  records/logs. Exact retention policy remains owned by `lane-gc`.
- `agetree engine <new|run|ls|merge|rm> ...` — raw engine namespace, argument-compatible with
  `agent-worktree.sh`, for scripts or humans that need exact Bash behavior/output during
  migration. A future `agent-worktree.sh` shim can call this without changing old users.

### `run` flags

- Lane identity: optional positional `branch` only in headless mode; positional `[base]` kept
  for engine compatibility; `--base <ref>` is the self-documenting equivalent for parent
  agents; `--name <slug>` influences auto-naming when no branch is given.
- Prompt: `--prompt <text>` or `--prompt-file <path|->`; mutually exclusive. Presence of
  either flag selects headless mode; absence preserves `agent-worktree.sh run <branch>`.
- Adapter: `--agent claude|amp` (default `claude`). Adapter-specific model controls stay
  namespaced: `--claude-model <model>` and `--amp-model <model>` if/when Amp exposes an
  equivalent. Do **not** pretend there is one portable `--model`; the CLIs diverge.
- Escape hatch: `--adapter-arg <arg>` repeatable for expert adapter-specific argv additions.
- Execution: background by default; `--wait` blocks until terminal/reconciled status;
  `--timeout <duration>` sets max run budget; `--idle-timeout <duration>` is the optional
  no-output safety net from `execution-model`.
- Output: `--json` is orthogonal to `--wait`. Under `--json`, stdout is exactly one
  newline-terminated JSON object and all progress/diagnostics go to stderr. With
  `--wait --json`, the object is terminal; with `--json` alone, it is the initial `running`
  record.
- Exit codes: without `--wait`, `0` means spawned/tracked successfully and `2` means an
  agetree operational error. With `--wait`: `0` = `done`, `1` = terminal non-`done`,
  `2` = operational error.

### Usage examples

Human compatibility workflow:

```sh
agetree new ui-polish main
agetree run ui-polish
agetree ls
agetree merge main ui-polish --rm
```

Parent-agent function-call style:

```sh
payload=$(agetree run --agent amp --prompt-file task.md --base main --wait --json)
status=$(printf '%s' "$payload" | jq -r '.status')
test "$status" = done
```

### Tradeoffs / risks

- **Overloaded `run` is deliberate** — Prompt presence is the mode switch. This is less pure
  than a separate `spawn` verb, but it preserves `agent-worktree.sh run <branch>` and keeps
  the resolved parent-agent command (`agetree run --prompt ...`) short.
- **Branch positional ambiguity** — `agetree run foo --prompt …` could mean lane name or raw
  branch. Public commands should accept either, normalize to the lane record's canonical
  `branch`, and always print both `name` and `branch`.
- **Adapter flags leak provider details** — Namespaced model flags are less elegant than
  `--model`, but they avoid a false abstraction: Claude and Amp controls are not equivalent
  today. A later adapter can add its own namespaced options without breaking the parent-agent
  contract.
- **`--json` without `--wait` can surprise parents** — It returns a `running` record, not a
  result. The skill must teach parent agents to use `--wait --json` for delegation unless
  they intentionally want fire-and-forget.
- **JSON contract is strict** — JSON-only stdout under `--json` is excellent for parents but
  requires discipline: all progress, warnings, and adapter stderr must route to stderr/logs.
- **Cleanup policy is deferred** — `rm`/`merge --rm` can remove worktrees today, but lane
  record/log pruning remains a separate `lane-gc` decision. This avoids baking in a cleanup
  policy before the lifecycle owner is decided.

## ts-bash-boundary: Which Responsibilities Cross The TS↔Bash Seam

Blocked by: cli-surface
Status: resolved
Type: Grilling

### Question

Pin the contract between the TS orchestrator and the Bash engine: exactly which
operations TS delegates to `agent-worktree.sh` (create/list/merge/rm) vs owns itself
(headless run, adapters, state, payload), how TS invokes the script and parses its
output, and error/version handling across the seam. Keep the seam thin and one-directional.

### Answer

Resolved by grilling. The seam is **one-directional and effect-only**: TS is the public
orchestrator and shells out to the Bash engine for the lifecycle effects the Bash already
does well; Bash remains unaware of `.agetree/` lane state, adapters, payloads, and TS. TS
must **not parse human Bash output** as a data protocol. If TS needs facts, it derives them
from git (`git worktree list --porcelain`, `git status`, `rev-parse`, `merge-base`) and the
lane record.

### Ownership split

**Bash engine owns the proven worktree/runtime mechanics:**

- `new <branch> [base]` — create or check out the lane worktree, choose the default base
  when no explicit base is supplied, allocate env/ports, copy/link env files, handle
  git-crypt, install dependencies, and write `.agent-ports` / `.lando.local.yml`.
- `run <branch>` — start the interactive dev stack for a worktree. This is **not** the
  headless agent run path.
- `merge <target> [branches...] [--all] [--rm]` — preserve the existing safe merge-back
  behavior: dirty-worktree checks, clean-main-checkout check, conflict messaging, container
  teardown, optional worktree cleanup.
- `rm <branch>` — remove/tear down an interactive worktree using the existing runtime
  cleanup. Lane record/log pruning remains `lane-gc`'s job.
- `ls` — only the legacy worktree-centric human table, exposed under `agetree engine ls` or
  other compatibility passthroughs. It is **not** the implementation of public `agetree ls`.

**TS orchestrator owns everything that makes a lane headless and machine-readable:**

- public CLI parsing/routing (`agetree run`, `ls`, `logs`, `merge`, `rm`, `engine …`) and all
  `--json` / `--wait` behavior;
- prompt ingestion, auto-naming, lane-name ↔ branch resolution, and adapter selection;
- the detached supervisor, agent adapters, stdout/stderr capture, log files, timeouts, and
  `reconcile()`;
- `.agetree/lanes/<name>.json` records and `.agetree/logs/<name>.log`;
- auto-commit after a clean agent exit, commit failure handling, `filesChanged`, `baseSha`,
  `commit.sha`, and the final `payload` shape;
- public `agetree ls [--json]`, which is lane-centric: read lane records, read git worktrees
  directly, derive `orphaned` / interactive worktrees, and never delegate to the Bash `ls`;
- `logs` and later `gc`/`reap` lifecycle-owner behavior.

### Headless `run` sequencing

For v1, headless setup is intentionally **foreground before detach**:

1. TS resolves/creates the lane name and canonical branch.
2. TS checks `git worktree list --porcelain` for an existing worktree for that branch.
3. If absent, TS invokes `agent-worktree.sh new <branch> [base]`.
4. TS re-reads `git worktree list --porcelain` keyed by branch to find the actual worktree
   path. If the path is still missing, that is an agetree operational error.
5. Only after a real worktree exists does TS create the lane record/log and spawn the
   detached supervisor that runs the selected agent adapter.

This avoids inventing a `creating` lane status, keeps `running` meaning "a supervisor owns
an existing lane worktree", and makes engine setup failures immediate operational errors
(`exit 2`) rather than failed agent payloads for a lane that never existed. The cost is that
`agetree run --prompt …` may block while the Bash `new` command installs dependencies; that
is acceptable for v1 because it preserves the simpler state machine. If that becomes painful,
add a later ticket for a `creating` status / setup-in-supervisor design.

### Invocation contract

- TS locates the engine as the repo-root `agent-worktree.sh` and invokes it with argv arrays
  (`spawnFile`/`spawn`, no shell string construction):
  - `new`: capture/tee engine stdout+stderr to the lane log when one exists, and otherwise
    route progress to stderr. Under `--json`, stdout remains reserved for the single JSON
    object only.
  - interactive passthroughs (`agetree run <branch>` without prompt, `agetree engine …`, and
    human `merge`/`rm`): use inherited stdio so prompts, dev servers, merge conflicts, and
    container output behave exactly like the Bash script.
  - `merge`/`rm` invoked from higher-level TS commands first normalize lane names to branch
    names, then delegate the effect to Bash.
- TS treats Bash stdout/stderr as **diagnostics**, never as structured data. The only stable
  Bash signal TS consumes is process exit success/failure.
- After every delegated effect that matters to TS, TS re-reads authoritative state from git
  rather than trusting printed text:
  - worktree path: `git worktree list --porcelain` keyed by `refs/heads/<branch>`;
  - current branch/head: `git -C <worktree> rev-parse …`;
  - dirty state/files: `git -C <worktree> status --porcelain`;
  - review range: `git merge-base <base> HEAD` / `rev-parse HEAD`.

### Error handling

- In the headless setup path, a nonzero engine exit is an **agetree operational error**:
  print diagnostics to stderr/log, do not emit a fake payload, and exit `2` (matching the
  `cli-surface` contract). With no worktree, there is no mergeable lane result to report.
- In background headless mode after setup succeeds, supervisor/adapter/auto-commit failures
  are lane failures (`status: failed`) because a real lane record exists and owns the
  lifecycle.
- In passthrough compatibility mode, preserve the Bash engine's behavior and exit code; do
  not remap it unless the TS wrapper itself failed before invoking Bash.
- Under any `--json` mode, TS must keep agetree and engine diagnostics off stdout. stdout is
  exactly the JSON object or empty on operational error.
- If TS needs to show an engine failure in a lane log or terminal, include the engine command
  name and exit code plus stderr excerpts; avoid depending on exact Bash prose.

### Version / protocol handling

No separate engine protocol version in v1. The Bash script and TS orchestrator are
co-versioned in the same repo/package, and the seam deliberately has no machine-readable
Bash protocol to negotiate. TS should fail fast if `agent-worktree.sh` is missing or not
executable, and tests should cover the small set of delegated argv shapes.

If agetree later distributes TS separately from the Bash engine, add an explicit
`agent-worktree.sh engine-version` / `capabilities` command then. Do **not** add it now just
to protect against a deployment model the project has not earned.

### Design guardrails

- Do not move port allocation, env-file handling, git-crypt setup, runtime detection, or
  merge safety into TS in v1. That duplicates the engine instead of using it.
- Do not make Bash read or mutate `.agetree/lanes`; that would turn the seam bidirectional
  and split lane-state ownership.
- Do not scrape `agent-worktree.sh ls` or success messages. If TS needs machine data, read
  git directly or add a deliberately machine-readable engine command in a future ticket.
- Keep the adapter seam separate from the TS↔Bash seam: adapters vary by external agent CLI;
  the Bash engine varies by local repo/runtime worktree mechanics.
- `merge --rm` and `rm` may remove worktrees, but lane record/log cleanup is still deferred
  to `lane-gc` so post-supervisor disk mutation has one owner.

### Handoff to implementation

The smallest implementation slice is a TS `Engine` module with a tiny interface:

```ts
type Engine = {
  ensureWorktree(branch: string, base?: string): Promise<{ branch: string; path: string }>;
  runInteractive(branch: string): Promise<number>; // inherited stdio
  merge(target: string, branches: string[], opts: { all?: boolean; rm?: boolean }): Promise<number>;
  remove(branch: string, opts: { force?: boolean }): Promise<number>;
};
```

Only `ensureWorktree` returns structured data, and it gets that data by re-reading git after
calling Bash, not by parsing Bash. Public `ls`, `logs`, `run --prompt`, payload shaping, and
lane GC stay outside this module.

## skill-design: The Agent-Facing "When To Fan Out" Skill

Blocked by: cli-surface, result-payload
Status: open
Type: Grilling

### Question

Design the skill that teaches a parent agent when delegating to a lane is worth it, how
to invoke the CLI, and how to read the payload back. What triggers it, what guardrails
(don't recurse infinitely, don't fan out trivial work), and how it references the CLI
surface. Reuse `/writing-great-skills`.

### Answer

<open>

## lane-gc: Pruning Terminal Lanes & Killing Timed-Out Processes

Blocked by: cli-surface
Status: open
Type: Grilling

### Question

Surfaced by `lane-state`. `reconcile()` is pure and `ls`/`--wait` never write, so this
ticket owns every disk mutation of lane state *after* the supervisor is gone. Three jobs:
(1) **persist healed statuses** — a lifecycle-owning command re-runs `reconcile()` and
atomically (temp + rename) writes back `stale`/`timed-out` so records stop lying to the
Bash side / `--json` / a human `cat`; (2) **kill the process** behind a `timed-out` (and
possibly `stale`) lane — reconcile only classifies, something must actually send the
signal; (3) **prune** terminal records in `.agetree/lanes/` + logs in `.agetree/logs/`.
Decide where each lives: on `rm`? on `merge --rm`? an explicit `gc`/`reap` verb? age-based
or a cap on kept lanes? Keep it consistent with the Bash engine's `rm`/`merge --rm`
lifecycle. Note the resurrection race even a lifecycle command must avoid: re-read + guard
that the record is still non-terminal before overwriting it.

### Answer

<open>
