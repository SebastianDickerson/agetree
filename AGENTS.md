# AGENTS.md

## What this is

**agetree** is a personal, sandcastle-style orchestrator: it runs coding agents in
isolated git-worktree "lanes" (interactively *or* headless), then merges their work
back safely. Agents can themselves spawn lanes and delegate sub-tasks (recursive
fan-out). It is **still in the planning phase** — there is no product code yet, only a
decision map and throwaway spikes.

## The map is canonical

[`DECISION-MAP.md`](./DECISION-MAP.md) is the single source of truth. It holds the
domain glossary, every resolved decision (with rationale), and the open **frontier
tickets** with their `Blocked by` edges. Read it first and in full — it is the memory
of this project, not any individual chat thread.

Supporting assets are linked *from* the map, never duplicated in it:
- [`docs/adapters.md`](./docs/adapters.md) — verified Claude Code + Amp headless seam.
- [`prototypes/lane-state/`](./prototypes/lane-state/) — lane state machine + reaping.
- [`spike/agent-adapter/`](./spike/agent-adapter/) — runnable adapter proof.
- [`agent-worktree.sh`](./agent-worktree.sh) — the proven Bash worktree engine (the seed).

## How to work a ticket

This project is driven by the **decision-mapping** workflow. One ticket per session:

1. Load the **whole** `DECISION-MAP.md`.
2. Pick a ticket — the named one, else the first `open` ticket in document order whose
   `Blocked by` list is fully `resolved`. **Claim it**: set `Status: in-progress` and
   save before doing any work (concurrent sessions skip claimed tickets).
3. Resolve it using the ticket's `Type` (Research / Prototype / Grilling). Write the
   answer into the ticket body and set `Status: resolved`. Add any newly-discovered
   tickets with correct `Blocked by` edges.
4. **Handoff**: end the session, list the now-unblocked tickets as copy-paste
   invocations, and commit (one commit per ticket keeps diffs clean).

Never resolve more than one ticket per session. Run only *unblocked* tickets in
parallel — expect other sessions to be editing the map concurrently.

## Skill dependencies (may be absent)

The map's `## Notes` block says to consult `/agent-worktrees`, `/codebase-design`,
`/grilling`, `/domain-modeling`, and `/prototype`. These are the author's personal
skills and are **not vendored in this repo** — on another machine they may not exist.
If a referenced skill is unavailable, fall back to first principles: the map's glossary
and resolved decisions carry the context those skills would have supplied. Do not block
on a missing skill.

## Conventions

- **Runtime split**: keep the worktree engine in Bash (`agent-worktree.sh`); write new
  orchestration in TypeScript that shells out to it.
- **Smallest correct change.** Don't build isolation / MCP / multi-provider machinery
  before the CLI shape has earned it.
- **Never commit `.agetree/`** — it holds runtime lane logs that can contain secrets and
  prompts (already gitignored).
