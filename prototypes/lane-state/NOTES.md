# lane-state — answer

What driving the prototype settled. The full write-up is folded into the
`lane-state` ticket in `DECISION-MAP.md`; this is the working record.

## Storage layout

```
.agetree/
  lanes/<name>.json   one record per lane
  logs/<name>.log     combined agent stdout+stderr
```

- **One file per lane**, not a single index. No lock contention between
  concurrent supervisors; a crashed run just leaves a readable JSON behind;
  `ls` = `readdir` + parse + reconcile.
- `.agetree/` sits at the repo root and is kept out of git the same way the Bash
  engine already hides `.agent-ports` — appended to `info/exclude`, not the
  tracked `.gitignore`.
- Record fields: `name, branch, prompt, supervisorPid, status, startedAt,
  endedAt, logPath, payload`.

## State machine

```
                    ┌──────── agentExit(0, commit ok) ────────▶ done
   spawn ─▶ running ─┼──────── agentExit(≠0 | commit err) ─────▶ failed
                    │  · · · · reconcile: pid dead · · · · · · ▶ stale
                    └· · · · · reconcile: over budget · · · · ·▶ timed-out
```

- **Solid edges = authoritative writes** the supervisor makes. Only two:
  `spawn` when it starts, `agentExit` when its child exits. Idempotent — a late
  event on a terminal record is ignored.
- **Dotted edges = read-time reconciliation.** Pure classification computed by
  `ls`/`--wait`, never a supervisor write.

## The reaping model (the real answer)

`agetree run` spawns a **detached per-lane supervisor** (`setsid` / `unref`) and
returns immediately. The supervisor is the reaper:

1. writes the `running` record,
2. redirects the agent's stdout+stderr to `.agetree/logs/<name>.log`,
3. **waits** for the agent,
4. on exit writes the terminal status + payload, auto-commits on clean exit,
5. exits.

But the supervisor can itself be `kill -9`'d or lost to a reboot, leaving the
record stuck at `running` with a dead pid. **The reaper needs a reaper:**
`reconcile()` re-checks every `running` record at read time —

- supervisor pid no longer alive → `stale`,
- alive but past `maxRunMs` → `timed-out` (CLI should also kill the process).

This is why reconciliation is pure and lives on the read path: it is the only
thing that ever runs after the spawner is gone.

## Decisions surfaced

- **Commit-on-clean-exit policy:** `exit 0 + committed → done`;
  `exit 0 + nothing to commit → done`; `exit 0 + commit ERRORED → failed`
  (can't hand back a mergeable branch); `exit ≠ 0 → failed`, worktree left dirty
  for inspection. `stale`/`timed-out` keep the dirty worktree too (no known exit
  code to trust).
- **Does `ls` persist reconciled statuses? No — reads never write.**
  `reconcile()` is pure classification; who *persists* is the policy (the `[p]`
  toggle lets you feel both). Decided: **derive on every read, persist only from
  a command that already owns the lifecycle** (`rm` / `merge --rm` / an explicit
  `gc`/`reap` — the `lane-gc` ticket). `ls`/`--wait` display the reconciled
  status but never touch disk. Why not persist from `ls`:
  - `ls` is the most-run, most-concurrent command → concurrent writers to one
    lane file can tear the JSON (needs atomic temp + rename to be safe at all).
  - **Resurrection race**: `ls` reads `running`, sees a dead pid, decides
    `stale`, and in the gap the supervisor finishes and writes `done` — the `ls`
    write then clobbers `done` + its payload/sha. A pure read can never do this.
  - A persisting `ls` needs write perms + a writable disk, and fails on a
    read-only/full mount when all you wanted was to look. `--wait` polling
    amplifies every write risk.
  - Pure-derive *alone* isn't enough either: a `stale` record then lies forever
    on disk to anything that reads raw JSON (Bash side, `--json`, a human
    `cat`). So an owner still self-heals it — just at a well-defined moment, with
    a re-read + non-terminal guard, not on every glance.
- **Coexistence with the Bash engine:** `agetree ls` is lane-centric (reads
  `.agetree/lanes/`); `agent-worktree.sh ls` is worktree-centric. They key on
  **branch**. A worktree with no lane record = an interactive worktree agetree
  never drove (shown dimmed). A terminal lane whose worktree was `rm`'d = an
  `orphan` (a derived flag, never a status).

## Left open (fed forward)

- **Who owns every post-supervisor disk write?** Added `lane-gc` (blocked by
  `cli-surface`) to own three jobs: persist healed `stale`/`timed-out` statuses
  (atomic, with a re-read + non-terminal guard against the resurrection race),
  actually kill the process behind a `timed-out` lane, and prune terminal
  records + logs.
- Exact payload fields are `result-payload`'s job; the `payload` blob here is a
  placeholder shaped to match.
- The detach mechanism + output redirection details overlap with
  `agent-adapter` (how each CLI runs headless and exits).
