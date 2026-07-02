// lane-state.mjs — PURE state module for the `lane-state` decision-map ticket.
//
// THE QUESTION (see NOTES.md): background lanes run detached, so nobody is
// blocking on them. Where does durable per-lane state live, what is the legal
// state machine, and — the real unknown — how does a lane get *reaped* into a
// terminal status when the thing that spawned it has already walked away?
//
// This module owns ONLY the logic worth keeping. It is pure: no fs, no process,
// no clock, no git. Everything external (liveness of a pid, whether a worktree
// still exists, the current time, the outcome of the auto-commit) is passed IN.
// That is what lets it lift straight into the real TS orchestrator later; the
// tui.mjs shell around it is throwaway.
//
// Storage shape it assumes (the CLI/supervisor owns the fs, not this module):
//   .agetree/lanes/<name>.json   one record per lane (the objects below)
//   .agetree/logs/<name>.log     combined agent stdout+stderr
// One file per lane = no lock contention between concurrent supervisors, and a
// crashed run just leaves a readable JSON behind. `ls` = read the dir + reconcile.

/** @typedef {'running'|'done'|'failed'|'stale'|'timed-out'} Status */

export const STATUS = /** @type {const} */ ({
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  STALE: 'stale', // supervisor died without recording a terminal status
  TIMED_OUT: 'timed-out', // safety-net: ran past the max/idle budget
});

const TERMINAL = new Set([STATUS.DONE, STATUS.FAILED, STATUS.STALE, STATUS.TIMED_OUT]);
export const isTerminal = (status) => TERMINAL.has(status);

// ── Authoritative transitions ────────────────────────────────────────────
// These are the ONLY writes a supervisor makes. `spawn` when it starts,
// `agentExit` when the child it is babysitting exits. Everything else about a
// lane's status is *derived* at read time by reconcile() — see the big comment
// there for why the reaper needs a reaper.

/**
 * @param {{name:string, branch:string, prompt:string, supervisorPid:number, now:number}} e
 * @returns {object} a fresh running record
 */
export function spawn({ name, branch, prompt, supervisorPid, now }) {
  return {
    name,
    branch,
    prompt,
    supervisorPid,
    status: STATUS.RUNNING,
    startedAt: now,
    endedAt: null,
    logPath: `.agetree/logs/${name}.log`,
    payload: null,
  };
}

/**
 * Supervisor's child exited. This is where the output-capture policy lives:
 *   exit 0 + commit ok        → done   (branch is mergeable)
 *   exit 0 + nothing to commit→ done   (agent changed nothing — still clean)
 *   exit 0 + commit ERRORED   → failed (can't hand back a mergeable branch)  ← design call
 *   exit != 0                 → failed (worktree left dirty for inspection)
 *
 * @param {object} record
 * @param {{exitCode:number, now:number, commit?:{outcome:'committed'|'nothing'|'error', sha?:string}, filesChanged?:number, finalMessage?:string}} e
 */
export function agentExit(record, { exitCode, now, commit, filesChanged = 0, finalMessage = '' }) {
  if (!record || record.status !== STATUS.RUNNING) {
    // idempotency guard: a late exit event for an already-terminal lane is ignored.
    return record;
  }
  const cleanExit = exitCode === 0;
  const commitOk = !commit || commit.outcome === 'committed' || commit.outcome === 'nothing';
  const status = cleanExit && commitOk ? STATUS.DONE : STATUS.FAILED;
  return {
    ...record,
    status,
    endedAt: now,
    payload: {
      exitCode,
      commit: cleanExit ? commit ?? { outcome: 'nothing' } : { outcome: 'skipped' },
      filesChanged,
      finalMessage,
    },
  };
}

// ── Read-time reconciliation (the reaper's reaper) ─────────────────────────
//
// A detached supervisor writes `done`/`failed` on a clean exit. But if the
// SUPERVISOR itself is killed -9, the box reboots, or the run wedges forever,
// no terminal write ever happens and the record is stuck at `running` with a
// pid that points at nothing (or the wrong process). Nobody is coming back to
// fix it — the spawner is long gone.
//
// So `ls` (and `--wait`) must reconcile a `running` record against reality
// every time they read it:
//   - supervisor pid no longer alive  → `stale`   (crashed/killed mid-run)
//   - alive but past the max budget   → `timed-out` (CLI should also kill it)
// This is pure classification. Whether the caller PERSISTS the new status or
// just displays it is a policy the caller owns (persistReconcile toggle in the
// TUI) — read commands that silently rewrite state are surprising, but never
// healing a stale record means it lies forever. The prototype exists to feel
// out which side of that tradeoff is right.
//
// `orphaned` is a separate *derived flag*, never a status: a terminal lane
// whose worktree was `rm`'d out from under it. That's how agetree-state and the
// Bash engine's worktree list drift apart, and how `ls` should flag it.

/**
 * @param {object} record
 * @param {{now:number, isAlive:(pid:number)=>boolean, worktreeExists:(branch:string)=>boolean, maxRunMs?:number}} probe
 * @returns {{record:object, changed:boolean, flags:{orphaned:boolean}}}
 */
export function reconcile(record, { now, isAlive, worktreeExists, maxRunMs }) {
  const orphaned = isTerminal(record.status) && !worktreeExists(record.branch);

  if (record.status !== STATUS.RUNNING) {
    return { record, changed: false, flags: { orphaned } };
  }

  if (!isAlive(record.supervisorPid)) {
    return {
      record: {
        ...record,
        status: STATUS.STALE,
        endedAt: now,
        payload: { exitCode: null, reason: 'supervisor died without recording completion' },
      },
      changed: true,
      flags: { orphaned: !worktreeExists(record.branch) },
    };
  }

  if (maxRunMs && now - record.startedAt > maxRunMs) {
    return {
      record: {
        ...record,
        status: STATUS.TIMED_OUT,
        endedAt: now,
        payload: { exitCode: null, reason: `exceeded max run budget of ${maxRunMs}ms` },
      },
      changed: true,
      flags: { orphaned: false },
    };
  }

  return { record, changed: false, flags: { orphaned } };
}

// ── `ls` view ──────────────────────────────────────────────────────────────
// agetree's `ls` is LANE-centric (status/prompt/payload), and coexists with the
// Bash engine's WORKTREE-centric `ls` (ports/branch). They overlap on branch
// name. A worktree with no lane record is an interactive worktree agetree never
// drove — shown dimmed so the two views reconcile into one picture.

/**
 * @param {object[]} records
 * @param {object} probe                 same probe reconcile() takes
 * @param {string[]} [bareWorktrees]     branch names present as worktrees but with NO lane record
 * @returns {{rows:object[], reconciled:object[]}}
 *   rows: display rows (lanes reconciled + bare worktrees). reconciled: the
 *   records after reconcile, for a caller that chose to persist healed statuses.
 */
export function renderLs(records, probe, bareWorktrees = []) {
  const reconciled = [];
  const rows = records.map((rec) => {
    const { record, changed, flags } = reconcile(rec, probe);
    reconciled.push(record);
    return {
      kind: 'lane',
      name: record.name,
      branch: record.branch,
      status: record.status,
      healed: changed, // status differs from what's on disk → candidate to persist
      orphaned: flags.orphaned,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      payload: record.payload,
      logPath: record.logPath,
    };
  });
  for (const branch of bareWorktrees) {
    rows.push({ kind: 'worktree', name: branch, branch, status: '—' });
  }
  return { rows, reconciled };
}
