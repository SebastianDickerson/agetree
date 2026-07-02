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
- **Payload** — the structured result a finished lane yields.

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
Status: open
Type: Grilling

### Question

Define the structured payload a finished lane yields: fields (branch, commit sha(s),
files changed, agent final message, exit code, timings, log path), the machine format
(JSON to stdout when `--wait`/`--json`, human-readable otherwise), and how the parent
agent is expected to consume it. Depends on what each adapter can actually emit.

### Answer

<open>

## cli-surface: Command & Flag Design

Blocked by: agent-adapter, lane-state, result-payload
Status: open
Type: Grilling

### Question

Design the `agetree` command surface and how it composes with the engine's existing
`new/run/ls/merge/rm`. What are the verbs (`run`, maybe `spawn`), the flags
(`--prompt`, `--prompt-file`, `--wait`, `--json`, base branch, timeout), and the naming
so it's ergonomic both for a human fanning out and for a parent agent shelling out?
Consider `/design-an-interface` to sketch 2–3 shapes before committing.

### Answer

<open>

## ts-bash-boundary: Which Responsibilities Cross The TS↔Bash Seam

Blocked by: cli-surface
Status: open
Type: Grilling

### Question

Pin the contract between the TS orchestrator and the Bash engine: exactly which
operations TS delegates to `agent-worktree.sh` (create/list/merge/rm) vs owns itself
(headless run, adapters, state, payload), how TS invokes the script and parses its
output, and error/version handling across the seam. Keep the seam thin and one-directional.

### Answer

<open>

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
