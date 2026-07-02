// tui.mjs — THROWAWAY terminal shell for driving the lane-state machine by hand.
// Run: node prototypes/lane-state/tui.mjs
//
// Everything the real world would provide (the .agetree/lanes dir on disk, pid
// liveness, worktree existence, the wall clock, the auto-commit result) is
// SIMULATED in memory here so you can press keys and watch the state machine
// react to cases that are annoying to reproduce for real: a supervisor killed
// -9 mid-run, a run that overruns its budget, a commit that fails on a clean
// exit, a worktree rm'd out from under a finished lane. The logic lives in
// lane-state.mjs; this file is deletable.

import * as L from './lane-state.mjs';

// ── Simulated world ──────────────────────────────────────────────────────
const lanes = new Map(); // name -> record   (stands in for .agetree/lanes/*.json)
const alivePids = new Set(); // supervisor pids currently "running"
const worktrees = new Set(); // branches that still have a worktree on disk
let clock = 0; // simulated ms; [t] advances it
let nextPid = 4000;
let seq = 0;
let selected = null; // selected lane name
let persistReconcile = false; // policy: does `ls` write healed statuses back to disk?
let maxRunMs = 30_000; // safety-net budget
let waitOn = null; // lane name we're simulating `--wait` on
let logView = null; // lane name whose log we're tailing
const CLOCK_STEP = 10_000;

const CANNED_PROMPTS = [
  'add a dark-mode toggle to settings',
  'write unit tests for the parser',
  'fix the flaky login redirect',
  'refactor the port allocator',
];

const probe = () => ({
  now: clock,
  isAlive: (pid) => alivePids.has(pid),
  worktreeExists: (branch) => worktrees.has(branch),
  maxRunMs,
});

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');

function selectedRec() {
  return selected ? lanes.get(selected) : null;
}
function firstRunning() {
  for (const r of lanes.values()) if (r.status === L.STATUS.RUNNING) return r;
  return null;
}

// ── Actions ──────────────────────────────────────────────────────────────
function doSpawn() {
  const prompt = CANNED_PROMPTS[seq % CANNED_PROMPTS.length];
  const ts = (clock / 1000).toString(36);
  const name = `agetree/${slug(prompt)}-${ts}`;
  const branch = name;
  const pid = nextPid++;
  seq++;
  alivePids.add(pid);
  worktrees.add(branch);
  lanes.set(name, L.spawn({ name, branch, prompt, supervisorPid: pid, now: clock }));
  selected = name;
}

function exitSelected(kind) {
  const rec = selectedRec() ?? firstRunning();
  if (!rec || rec.status !== L.STATUS.RUNNING) return;
  alivePids.delete(rec.supervisorPid); // supervisor exits after writing terminal state
  let ev;
  if (kind === 'clean')
    ev = { exitCode: 0, now: clock, commit: { outcome: 'committed', sha: sha() }, filesChanged: 3, finalMessage: 'Done. Added the toggle.' };
  else if (kind === 'nochange')
    ev = { exitCode: 0, now: clock, commit: { outcome: 'nothing' }, filesChanged: 0, finalMessage: 'Nothing needed changing.' };
  else if (kind === 'commiterr')
    ev = { exitCode: 0, now: clock, commit: { outcome: 'error' }, filesChanged: 2, finalMessage: 'Edited files but commit failed.' };
  else ev = { exitCode: 1, now: clock, filesChanged: 1, finalMessage: 'Crashed: TypeError at line 42.' };
  lanes.set(rec.name, L.agentExit(rec, ev));
}

function killSupervisor() {
  const rec = selectedRec() ?? firstRunning();
  if (!rec || rec.status !== L.STATUS.RUNNING) return;
  // kill -9 / reboot: pid dies, NO terminal state written. Record still says running.
  alivePids.delete(rec.supervisorPid);
}

function removeWorktree() {
  const rec = selectedRec();
  if (!rec) return;
  worktrees.delete(rec.branch);
}

function persistHealed() {
  // If policy is on, `ls` writes reconciled statuses back to the lane files.
  const { reconciled } = L.renderLs([...lanes.values()], probe());
  for (const r of reconciled) lanes.set(r.name, r);
}

function cycleSelection() {
  const names = [...lanes.keys()];
  if (names.length === 0) return;
  const i = selected ? names.indexOf(selected) : -1;
  selected = names[(i + 1) % names.length];
}

function sha() {
  return Math.random().toString(16).slice(2, 9);
}

// ── Render ───────────────────────────────────────────────────────────────
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;
const C = { running: 33, done: 32, failed: 31, stale: 35, 'timed-out': 35 };
const color = (status) => (C[status] ? `\x1b[${C[status]}m${status}\x1b[0m` : status);

function fmtTime(ms) {
  return ms == null ? '—' : `${(ms / 1000).toFixed(0)}s`;
}

function render() {
  if (persistReconcile) persistHealed();
  const { rows } = L.renderLs([...lanes.values()], probe(), []);

  let out = '';
  out += B('lane-state prototype') + D(`   clock=${fmtTime(clock)}  maxRun=${fmtTime(maxRunMs)}  persist-on-ls=${persistReconcile ? 'ON' : 'off'}`) + '\n';
  out += D('simulates .agetree/lanes/*.json + pid liveness + worktree existence\n');
  out += '\n';

  // ── agetree ls (lane-centric) ──
  out += B('$ agetree ls') + D('  (lane-centric — reads .agetree/lanes/)') + '\n';
  if (rows.length === 0) out += D('  (no lanes — press [s] to spawn one)\n');
  for (const r of rows) {
    const sel = r.name === selected ? B('▸') : ' ';
    const flags = [r.healed ? D('(healed↺)') : '', r.orphaned ? '\x1b[31m(orphan!)\x1b[0m' : ''].filter(Boolean).join(' ');
    out += `${sel} ${color(r.status).padEnd(18)} ${r.name}  ${flags}\n`;
    out += D(`    prompt: ${lanes.get(r.name)?.prompt ?? ''}\n`);
    out += D(`    pid=${lanes.get(r.name)?.supervisorPid}  started=${fmtTime(r.startedAt)} ended=${fmtTime(r.endedAt)}  log=${r.logPath}\n`);
    if (r.payload) out += D(`    payload: ${JSON.stringify(r.payload)}\n`);
  }
  out += '\n';

  // ── coexistence: the Bash engine's worktree-centric ls ──
  out += B('$ ./agent-worktree.sh ls') + D('  (worktree-centric — git worktree list + .agent-ports)') + '\n';
  if (worktrees.size === 0) out += D('  (no worktrees)\n');
  for (const b of worktrees) {
    const hasLane = [...lanes.values()].some((r) => r.branch === b);
    out += D(`    ${b}   ${hasLane ? '' : '(interactive — no lane record)'}\n`);
  }
  out += '\n';

  // ── --wait view ──
  if (waitOn) {
    const rec = lanes.get(waitOn);
    const { rows: wr } = L.renderLs([rec], probe());
    const row = wr[0];
    out += B(`$ agetree run --wait  (${waitOn})`) + '\n';
    if (L.isTerminal(row.status)) {
      out += `  ${color(row.status)} — returning payload to caller:\n`;
      out += D(`  ${JSON.stringify(row.payload)}\n`);
    } else {
      out += D(`  blocking… status=${row.status} (advance clock / exit the lane to unblock)\n`);
    }
    out += '\n';
  }

  // ── logs view ──
  if (logView) {
    const rec = lanes.get(logView);
    out += B(`$ agetree logs ${logView}`) + D(`  (tails ${rec?.logPath})`) + '\n';
    out += D('  [agent] starting…\n  [agent] editing files…\n');
    if (rec && L.isTerminal(rec.status)) out += D(`  [agent] ${rec.payload?.finalMessage ?? ''}\n`);
    out += '\n';
  }

  out += D('─'.repeat(72) + '\n');
  out += [
    `${B('[s]')}pawn`,
    `${B('[j]')}next-select`,
    `${B('[0]')}exit-clean`,
    `${B('[z]')}exit-nochange`,
    `${B('[e]')}exit-commiterr`,
    `${B('[n]')}exit-fail`,
  ].join('  ') + '\n';
  out += [
    `${B('[k]')}kill-supervisor`,
    `${B('[t]')}tick-clock`,
    `${B('[x]')}rm-worktree`,
    `${B('[p]')}toggle-persist`,
    `${B('[w]')}toggle-wait`,
    `${B('[l]')}toggle-logs`,
    `${B('[q]')}uit`,
  ].join('  ') + '\n';

  process.stdout.write('\x1b[2J\x1b[H' + out);
}

// ── Input loop ─────────────────────────────────────────────────────────────
const handlers = {
  s: doSpawn,
  j: cycleSelection,
  '0': () => exitSelected('clean'),
  z: () => exitSelected('nochange'),
  e: () => exitSelected('commiterr'),
  n: () => exitSelected('fail'),
  k: killSupervisor,
  t: () => (clock += CLOCK_STEP),
  x: removeWorktree,
  p: () => (persistReconcile = !persistReconcile),
  w: () => (waitOn = waitOn ? null : selected),
  l: () => (logView = logView ? null : selected),
};

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  // Raw mode delivers one keystroke per event, but a pipe (or a terminal that
  // batches) can hand us several at once — process each char so both work.
  for (const key of chunk) {
    if (key === 'q' || key === '\u0003') {
      process.stdout.write('\x1b[2J\x1b[H');
      process.exit(0);
    }
    const h = handlers[key];
    if (h) h();
  }
  render();
});

render();
