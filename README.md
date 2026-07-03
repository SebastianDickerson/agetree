# agetree

**Run coding agents in isolated git-worktree lanes — interactively or headless — then merge their work back safely.**

agetree turns a git repo into a set of parallel **lanes**. Each lane is its own
worktree, branch, environment, and set of dev-server ports, so several agents (or
you) can work at once without stepping on each other. Point a lane at an agent with
a prompt and agetree drives it headless in the background, captures a structured
result, and — on a clean exit — leaves you a committed, mergeable branch.

> **Status:** young project, actively built. The Claude Code adapter and the full
> lane lifecycle (`run` / `ls` / `logs` / `gc` / `merge` / `rm`) work today. Amp is
> designed and verified against real runs ([`docs/adapters.md`](./docs/adapters.md))
> but not yet wired as a code adapter. It began as a personal power-tool; this README
> exists because the core has earned a look from other developers.

---

## Why use it

Most "run an agent in a worktree" setups give you isolation and stop there. agetree's
bet is that the interesting part is everything *around* the agent run:

- **Parallelism without collisions.** Every lane gets its own worktree, branch,
  copied `.env` files, and a distinct set of ports (Node/PHP/Vite/DB/Redis) derived
  per-lane. Agent A refactoring auth and agent B writing tests never fight over the
  working tree or port 3000. Stack detection (Node / Laravel-Sail / Lando) is
  automatic.

- **Agents as function calls.** `agetree run --prompt … --wait --json` spawns a lane,
  blocks until the agent finishes, and prints one structured record: git facts (commit
  sha, files changed), the agent's final message, exit status, turns, duration, cost.
  That makes one agent's output *consumable by another program or agent* instead of
  being trapped in a terminal.

- **Recursive fan-out.** Because spawning a lane is just a shell command, a running
  agent can spawn its **own** headless lanes and delegate sub-tasks — parent/child
  agents, arbitrarily deep.

- **Merge-back is safe by construction.** Clean exit → the lane auto-commits as a
  mergeable branch. Non-zero exit → **no commit**, the lane is marked `failed`, and the
  dirty worktree is kept for inspection. You never silently merge broken work, and you
  never lose it either. `merge` and `rm` delegate to a battle-tested Bash engine
  (dirty-worktree checks, clean-main check, conflict messaging) and only prune a lane's
  records once git confirms the worktree is actually gone.

- **Crash-safe background runs.** Each lane is driven by a detached per-lane supervisor
  that owns the run and writes the terminal status. State is one JSON file per lane (no
  lock contention), so a crash just leaves a readable record. `gc` heals, reaps, and
  prunes stale lanes on demand — nothing runs it implicitly.

If you only need one agent in one worktree, you don't need agetree. The moment you want
**several agents, results you can act on programmatically, agents that spawn agents, and
a merge-back you can trust** — that's the wedge.

---

## Install

Requires Node 22+ (uses `--experimental-strip-types` to run the TypeScript CLI
directly) and `git`. For headless Claude lanes you also need the `claude` CLI on PATH.

```sh
git clone https://github.com/SebastianDickerson/agetree.git
cd agetree
npm install

# put it on PATH (the launcher resolves its own real location, so a symlink works)
ln -s "$PWD/bin/agetree" ~/.local/bin/agetree
```

Run it from inside the git repo you want to spawn lanes in.

---

## Quickstart

```sh
# Drive an agent headless and wait for the result as JSON
agetree run --prompt "add a health-check endpoint at /healthz" \
            --claude-model sonnet --wait --json

# Fire-and-forget: spawns in the background, prints the lane name, returns immediately
agetree run fix-flaky-test --prompt "find and fix the flaky test in checkout.spec.ts"

# See what's running
agetree ls

# Tail a lane's output
agetree logs fix-flaky-test -f

# Merge the finished lane back into main and tear it down
agetree merge main fix-flaky-test --rm
```

Interactive mode (no prompt) hands you the worktree with its dev stack set up:

```sh
agetree run my-feature      # creates/enters the lane; you drive it yourself
```

---

## Commands

| Command | What it does |
| --- | --- |
| `run [branch] [base]` | Start a lane. **No prompt** → interactive worktree passthrough. **`--prompt` / `--prompt-file`** → drive an agent headless in the background. |
| `ls [--json] [--all]` | List lanes, reconciled against real git worktrees. `--all` also shows interactive worktrees with no lane record. |
| `logs <lane\|branch>` | Print or tail (`-f`) a lane's log; `--lines <n>` for the tail. |
| `gc [--dry-run] [--json]` | The janitor: heal → kill → prune stale/terminal lanes. Only ever touches `.agetree/`, never a worktree or branch. Explicit only. |
| `merge <target> [branches…]` | Safe merge-back into `<target>`. `--all` merges every agent worktree; `--rm` removes each merged worktree and prunes its record. |
| `rm <lane\|branch>` | Tear down a lane's worktree, then prune its record + log once git confirms it's gone. `--force` forwards to the engine. |

Key `run` flags: `--wait` (block until terminal), `--json` (one JSON record on stdout),
`--agent <name>` (adapter, default `claude`), `--claude-model` / `--amp-model`,
`--timeout <dur>` / `--idle-timeout <dur>` (e.g. `30s`, `5m`, `1h`), `--name <slug>`
(influence the auto-generated lane name). Run `agetree <command> --help` for the full
surface.

**Exit codes** (headless `run`): without `--wait`, `0` = spawned. With `--wait`,
`0` = done, `1` = terminal-but-not-done (failed/timed-out), `2` = operational error.
This is what makes lanes safe to script.

---

## How it works

```
agetree <verb>
   │
   ├─ run --prompt …  →  detached supervisor  →  adapter (claude | amp | fake)
   │                          │                     builds argv, parses result
   │                          ├─ writes .agetree/lanes/<name>.json  (status, payload)
   │                          ├─ pipes agent output → .agetree/logs/<name>.log
   │                          └─ on clean exit: auto-commit the worktree
   │
   └─ new / run(interactive) / merge / rm  →  agent-worktree.sh (Bash engine)
                                                worktree + branch + env + ports,
                                                safe merge-back, teardown
```

- **Runtime split.** The proven Bash **worktree engine** (`agent-worktree.sh`) owns
  worktree creation, env/port setup, stack detection, and safe merge-back. The
  TypeScript **orchestrator** owns headless invocation, adapters, lane state, and the
  agent-facing CLI, and shells out to the engine.
- **Adapter seam.** Only two things vary per agent CLI: how you build its argv and how
  you parse its output into a `LaneResult`. An adapter is just
  `{ name, buildCommand(opts), parse(raw) → LaneResult }` plus a shared `runLane()`.
  Claude Code is wired; Amp is verified and documented; a `fake` adapter backs the tests.
- **State.** `.agetree/lanes/<name>.json` + `.agetree/logs/<name>.log`, hidden from git
  via the worktree's `info/exclude` (never committed — logs can contain secrets and
  prompts). `running → done/failed` are the only authoritative writes; `stale` and
  `timed-out` are derived at read time.

Design decisions and their rationale live in [`DECISION-MAP.md`](./DECISION-MAP.md),
which is the canonical memory of the project.

---

## Development

```sh
npm test          # vitest (unit + e2e)
npm run typecheck # tsc --noEmit
```

The CLI parser (`parseCli`) is a pure function, so the whole surface — mode switching,
flag mapping, exit codes — is unit-testable without spawning a subprocess.

---

## Caveats

- **Worktree-only isolation.** Headless agents run on the host with your permissions
  (via each CLI's permission-bypass flag). There's no container sandbox yet — the run
  seam is shaped so one could slot in later. Only point lanes at agents and repos you
  trust.
- **Pin a fast model for headless Claude lanes** — the default can be slow/multi-turn
  even for trivial prompts.
- **Amp** is designed and verified but not yet a runtime adapter.
