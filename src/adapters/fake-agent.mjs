#!/usr/bin/env node
/**
 * The fake agent — a scripted stand-in for a real coding CLI (Claude/Amp) used
 * by the deterministic, offline test seams. It reads a spec from the
 * `AGETREE_FAKE_SPEC` env var, optionally writes files into the current working
 * directory (simulating an agent doing work in a lane worktree), prints a
 * single `type:"result"` JSON object to stdout (the same shape the real
 * adapters emit), and exits with the requested code.
 *
 * Plain ESM (no build step) so it can be spawned as a subprocess anywhere.
 *
 * Spec shape (all fields optional):
 *   {
 *     finalMessage?: string,
 *     exitCode?: number,
 *     writeFiles?: { path: string, content: string }[],
 *     stderr?: string,
 *     isError?: boolean,
 *     sessionId?: string,
 *     numTurns?: number,
 *     durationMs?: number
 *   }
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const spec = (() => {
  const raw = process.env.AGETREE_FAKE_SPEC;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write("fake-agent: invalid AGETREE_FAKE_SPEC\n");
    process.exit(3);
  }
})();

for (const file of spec.writeFiles ?? []) {
  const target = isAbsolute(file.path) ? file.path : join(process.cwd(), file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content ?? "");
}

if (spec.stderr) process.stderr.write(spec.stderr);

const result = {
  type: "result",
  result: spec.finalMessage ?? "",
  is_error: spec.isError ?? false,
  session_id: spec.sessionId,
  num_turns: spec.numTurns,
  duration_ms: spec.durationMs,
};
process.stdout.write(JSON.stringify(result) + "\n");

process.exit(spec.exitCode ?? 0);
