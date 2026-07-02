import type { LaneResult } from "./adapter.ts";

export const STATUS = {
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  STALE: "stale",
  TIMED_OUT: "timed-out",
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

export type CommitOutcome = "committed" | "nothing" | "skipped" | "error";

export type CommitPayload = {
  outcome: CommitOutcome;
  sha?: string;
  baseSha?: string;
};

export type FilesChanged = {
  count: number;
  files: string[];
  truncated: boolean;
};

export type LanePayload = {
  exitCode: number;
  isError: boolean;
  finalMessage: string;
  reason?: string;
  commit?: CommitPayload;
  filesChanged?: FilesChanged;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
};

export type LaneRecord = {
  name: string;
  branch: string;
  adapter: string;
  prompt: string;
  supervisorPid: number;
  /** Process start time discriminator used to avoid pid-recycle mistakes. */
  supervisorStartedAt: number;
  status: Status;
  startedAt: number;
  endedAt?: number;
  logPath: string;
  payload: LanePayload | null;
  /** Derived at read time; never persisted by supervisor writes. */
  orphaned?: boolean;
};

export type SpawnRecordOptions = {
  name: string;
  branch: string;
  adapter: string;
  prompt: string;
  supervisorPid: number;
  supervisorStartedAt: number;
  startedAt: number;
  logPath: string;
};

export type AgentExitOptions = {
  now: number;
  result: LaneResult;
  commit: CommitPayload;
  filesChanged: FilesChanged;
  reason?: string;
};

export type ReconcileFacts = {
  now: number;
  supervisor: { alive: boolean; startedAt?: number };
  worktreeExists: boolean;
  maxRunMs?: number;
};

export type ReconcileResult = {
  record: LaneRecord;
  changed: boolean;
  flags: { orphaned: boolean };
};

const TERMINAL = new Set<Status>([
  STATUS.DONE,
  STATUS.FAILED,
  STATUS.STALE,
  STATUS.TIMED_OUT,
]);

export function isTerminal(status: Status): boolean {
  return TERMINAL.has(status);
}

export function spawnRecord(opts: SpawnRecordOptions): LaneRecord {
  return {
    name: opts.name,
    branch: opts.branch,
    adapter: opts.adapter,
    prompt: opts.prompt,
    supervisorPid: opts.supervisorPid,
    supervisorStartedAt: opts.supervisorStartedAt,
    status: STATUS.RUNNING,
    startedAt: opts.startedAt,
    logPath: opts.logPath,
    payload: null,
  };
}

export function agentExit(record: LaneRecord, opts: AgentExitOptions): LaneRecord {
  if (record.status !== STATUS.RUNNING) return record;

  const cleanExit = opts.result.exitCode === 0;
  const commitOk = opts.commit.outcome === "committed" || opts.commit.outcome === "nothing";
  const status = cleanExit && commitOk ? STATUS.DONE : STATUS.FAILED;
  const reason =
    status === STATUS.DONE
      ? undefined
      : opts.reason ??
        (cleanExit
          ? "auto-commit failed"
          : `agent exited ${opts.result.exitCode}`);

  return {
    ...record,
    status,
    endedAt: opts.now,
    payload: omitUndefined({
      exitCode: opts.result.exitCode,
      isError: opts.result.isError,
      finalMessage: opts.result.finalMessage,
      reason,
      commit: opts.commit,
      filesChanged: opts.filesChanged,
      sessionId: opts.result.sessionId,
      numTurns: opts.result.numTurns,
      durationMs: opts.result.durationMs,
      costUsd: opts.result.costUsd,
    }),
  };
}

export function reconcile(record: LaneRecord, facts: ReconcileFacts): ReconcileResult {
  const orphaned = isTerminal(record.status) && !facts.worktreeExists;
  if (record.status !== STATUS.RUNNING) {
    return {
      record: orphaned ? { ...record, orphaned: true } : stripOrphaned(record),
      changed: false,
      flags: { orphaned },
    };
  }

  if (!facts.supervisor.alive) {
    return heal(record, facts.now, STATUS.STALE, "supervisor died without recording completion", false);
  }

  if (
    facts.supervisor.startedAt !== undefined &&
    facts.supervisor.startedAt !== record.supervisorStartedAt
  ) {
    return heal(record, facts.now, STATUS.STALE, "supervisor pid was recycled", false);
  }

  if (facts.maxRunMs !== undefined && facts.now - record.startedAt > facts.maxRunMs) {
    return heal(
      record,
      facts.now,
      STATUS.TIMED_OUT,
      `exceeded max run budget of ${facts.maxRunMs}ms`,
      false,
    );
  }

  return { record: stripOrphaned(record), changed: false, flags: { orphaned: false } };
}

function heal(
  record: LaneRecord,
  endedAt: number,
  status: typeof STATUS.STALE | typeof STATUS.TIMED_OUT,
  reason: string,
  orphaned: boolean,
): ReconcileResult {
  return {
    record: {
      ...stripOrphaned(record),
      status,
      endedAt,
      payload: { exitCode: -1, isError: true, finalMessage: "", reason },
    },
    changed: true,
    flags: { orphaned },
  };
}

function stripOrphaned(record: LaneRecord): LaneRecord {
  if (record.orphaned === undefined) return record;
  const { orphaned: _orphaned, ...rest } = record;
  return rest;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
