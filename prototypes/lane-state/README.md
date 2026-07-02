# lane-state prototype

Throwaway logic prototype for the `lane-state` ticket in [`DECISION-MAP.md`](../../DECISION-MAP.md).

## The question

Background lanes run **detached** — `agetree run` returns immediately, so nobody
is blocking on the agent. Given that:

- Where does durable per-lane state live (`.agetree/lanes/<name>.json`? logs in
  `.agetree/logs/`?) and what fields does it hold?
- What is the legal **state machine** (`running → done/failed/stale/timed-out`)?
- **How is a detached lane tracked and reaped** into a terminal status when the
  thing that spawned it has already walked away — and what happens when the
  reaper itself dies?
- How does `ls`/`logs` read it, and how does it coexist with the Bash engine's
  own worktree-centric `ls`?

## Run

```
node prototypes/lane-state/tui.mjs
```

Press keys to drive the simulated world (in-memory `.agetree/lanes/` + pid
liveness + worktree existence + a hand-cranked clock). Cases worth feeling:

- `s` `0` — spawn, then a clean exit with a commit → `done` + payload.
- `s` `e` — clean exit but the auto-commit **errored** → `failed` (design call).
- `s` `k` `t` — spawn, kill the supervisor (`kill -9`/reboot), tick → `ls`
  reconciles the stuck `running` record to `stale`. **This is the core answer.**
- `s` (many ticks) — leave it running past `maxRun` → `timed-out` safety net.
- `0` then `x` — finish a lane, then `rm` its worktree → `(orphan!)` flag.
- `p` — toggle whether `ls` **persists** reconciled statuses back to disk.
- `w` — simulate `--wait` blocking until a lane reaches a terminal status.

## Files

- [`lane-state.mjs`](lane-state.mjs) — **the pure logic worth keeping.** No fs,
  no process, no clock: lifts straight into the TS orchestrator later.
- `tui.mjs` — throwaway terminal shell. Delete once the answer is banked.
- [`NOTES.md`](NOTES.md) — the answer this prototype established.
