import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LaneRecord } from "./lane-state.ts";

export type LaneStatePaths = {
  agetreeDir: string;
  lanesDir: string;
  logsDir: string;
  recordPath: string;
  logPath: string;
  relativeLogPath: string;
};

export function statePaths(root: string, name: string): LaneStatePaths {
  const agetreeDir = join(root, ".agetree");
  const lanesDir = join(agetreeDir, "lanes");
  const logsDir = join(agetreeDir, "logs");
  const relativeLogPath = `.agetree/logs/${name}.log`;
  return {
    agetreeDir,
    lanesDir,
    logsDir,
    recordPath: join(lanesDir, `${name}.json`),
    logPath: join(logsDir, `${name}.log`),
    relativeLogPath,
  };
}

/**
 * List the lane record names (file basenames sans `.json`) under
 * `.agetree/lanes/`, sorted. A read: returns `[]` when the dir is absent and
 * never creates it.
 */
export function listLaneNames(root: string): string[] {
  const { lanesDir } = statePaths(root, "");
  if (!existsSync(lanesDir)) return [];
  return readdirSync(lanesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function readLaneRecord(root: string, name: string): LaneRecord | null {
  const { recordPath } = statePaths(root, name);
  if (!existsSync(recordPath)) return null;
  return JSON.parse(readFileSync(recordPath, "utf8")) as LaneRecord;
}

export function writeLaneRecordAtomic(root: string, record: LaneRecord): void {
  const { recordPath } = statePaths(root, record.name);
  mkdirSync(dirname(recordPath), { recursive: true });
  const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, recordPath);
}
