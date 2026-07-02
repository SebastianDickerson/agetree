import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLane } from "../adapter.ts";
import { createFakeAdapter } from "./fake.ts";

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "agetree-fake-"));
}

describe("fake adapter", () => {
  it("runs through runLane and returns the scripted final message", async () => {
    const adapter = createFakeAdapter({ finalMessage: "all done" });

    const result = await runLane(adapter, {
      cwd: freshCwd(),
      prompt: "do the thing",
      allowAllTools: true,
    });

    expect(result.adapter).toBe("fake");
    expect(result.finalMessage).toBe("all done");
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
  });

  it("writes scripted files into the lane's working directory", async () => {
    const cwd = freshCwd();
    const adapter = createFakeAdapter({
      finalMessage: "wrote a file",
      writeFiles: [{ path: "src/greeting.txt", content: "hello from the lane" }],
    });

    await runLane(adapter, { cwd, prompt: "write a file", allowAllTools: true });

    expect(readFileSync(join(cwd, "src/greeting.txt"), "utf8")).toBe(
      "hello from the lane",
    );
  });

  it("reports a non-zero exit and flags isError", async () => {
    const adapter = createFakeAdapter({ finalMessage: "boom", exitCode: 2 });

    const result = await runLane(adapter, {
      cwd: freshCwd(),
      prompt: "fail please",
      allowAllTools: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.isError).toBe(true);
  });

  it("surfaces adapter metadata from the scripted result", async () => {
    const adapter = createFakeAdapter({
      finalMessage: "done",
      sessionId: "sess-123",
      numTurns: 4,
      durationMs: 987,
    });

    const result = await runLane(adapter, {
      cwd: freshCwd(),
      prompt: "meta",
      allowAllTools: true,
    });

    expect(result.sessionId).toBe("sess-123");
    expect(result.numTurns).toBe(4);
    expect(result.durationMs).toBe(987);
  });
});
