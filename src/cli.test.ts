import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import { parseCli, parseDuration, runCli } from "./cli.ts";

function collector(): Writable & { text: string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk;
      cb();
    },
  }) as Writable & { text: string };
  Object.defineProperty(stream, "text", { get: () => text });
  return stream;
}

describe("parseCli — verb routing", () => {
  it("routes an unknown verb to an error", () => {
    const r = parseCli(["frobnicate"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/unknown command 'frobnicate'/);
  });

  it("no args / --help / -h → help", () => {
    expect(parseCli([]).kind).toBe("help");
    expect(parseCli(["--help"]).kind).toBe("help");
    expect(parseCli(["-h"]).kind).toBe("help");
  });

  it("stubs the unimplemented verbs", () => {
    for (const verb of ["new", "logs", "merge", "rm", "gc", "engine"]) {
      const r = parseCli([verb]);
      expect(r.kind).toBe("stub");
      if (r.kind === "stub") expect(r.verb).toBe(verb);
    }
  });
});

describe("parseCli — run mode switch", () => {
  it("no prompt + branch → interactive passthrough", () => {
    const r = parseCli(["run", "ui-polish"]);
    expect(r).toEqual({ kind: "run-interactive", branch: "ui-polish" });
  });

  it("no prompt + no branch → error (missing branch/prompt)", () => {
    const r = parseCli(["run"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/requires a branch .* or --prompt/);
  });

  it("--prompt flips to headless mode", () => {
    const r = parseCli(["run", "--prompt", "do the thing"]);
    expect(r.kind).toBe("run-headless");
    if (r.kind === "run-headless") {
      expect(r.run.prompt).toBe("do the thing");
      expect(r.run.promptFile).toBeUndefined();
    }
  });

  it("--prompt-file flips to headless mode", () => {
    const r = parseCli(["run", "--prompt-file", "task.md"]);
    expect(r.kind).toBe("run-headless");
    if (r.kind === "run-headless") expect(r.run.promptFile).toBe("task.md");
  });

  it("errors when both --prompt and --prompt-file are given", () => {
    const r = parseCli(["run", "--prompt", "x", "--prompt-file", "y"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/mutually exclusive/);
  });
});

describe("parseCli — run flag mapping", () => {
  it("maps positionals, --base, --name, --agent", () => {
    const r = parseCli([
      "run",
      "agetree/feat",
      "develop",
      "--prompt",
      "go",
      "--name",
      "feat",
      "--agent",
      "amp",
    ]);
    expect(r.kind).toBe("run-headless");
    if (r.kind === "run-headless") {
      expect(r.run.branch).toBe("agetree/feat");
      expect(r.run.base).toBe("develop");
      expect(r.run.name).toBe("feat");
      expect(r.run.adapter).toBe("amp");
    }
  });

  it("--base flag takes precedence over the positional base", () => {
    const r = parseCli(["run", "br", "posbase", "--prompt", "x", "--base", "flagbase"]);
    if (r.kind === "run-headless") expect(r.run.base).toBe("flagbase");
    else throw new Error("expected run-headless");
  });

  it("defaults the adapter to claude", () => {
    const r = parseCli(["run", "--prompt", "x"]);
    if (r.kind === "run-headless") expect(r.run.adapter).toBe("claude");
    else throw new Error("expected run-headless");
  });

  it("namespaced model flags land on the right field", () => {
    const r = parseCli([
      "run",
      "--prompt",
      "x",
      "--claude-model",
      "sonnet",
      "--amp-model",
      "fast",
    ]);
    if (r.kind === "run-headless") {
      expect(r.run.claudeModel).toBe("sonnet");
      expect(r.run.ampModel).toBe("fast");
    } else throw new Error("expected run-headless");
  });

  it("collects repeatable --adapter-arg (dash-prefixed values need = form, a parseArgs rule)", () => {
    const r = parseCli(["run", "--prompt", "x", "--adapter-arg=--foo", "--adapter-arg", "bar"]);
    if (r.kind === "run-headless") expect(r.run.adapterArgs).toEqual(["--foo", "bar"]);
    else throw new Error("expected run-headless");
  });

  it("--json and --wait are independent and both parse", () => {
    const both = parseCli(["run", "--prompt", "x", "--json", "--wait"]);
    if (both.kind === "run-headless") {
      expect(both.run.json).toBe(true);
      expect(both.run.wait).toBe(true);
    } else throw new Error("expected run-headless");

    const jsonOnly = parseCli(["run", "--prompt", "x", "--json"]);
    if (jsonOnly.kind === "run-headless") {
      expect(jsonOnly.run.json).toBe(true);
      expect(jsonOnly.run.wait).toBe(false);
    } else throw new Error("expected run-headless");
  });

  it("parses --timeout / --idle-timeout durations into ms", () => {
    const r = parseCli(["run", "--prompt", "x", "--timeout", "5m", "--idle-timeout", "30s"]);
    if (r.kind === "run-headless") {
      expect(r.run.timeoutMs).toBe(300_000);
      expect(r.run.idleTimeoutMs).toBe(30_000);
    } else throw new Error("expected run-headless");
  });

  it("rejects a malformed duration", () => {
    const r = parseCli(["run", "--prompt", "x", "--timeout", "soon"]);
    expect(r.kind).toBe("error");
  });

  it("rejects an unknown flag", () => {
    const r = parseCli(["run", "--prompt", "x", "--bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/bogus/i);
  });

  it("run --help → help for run", () => {
    const r = parseCli(["run", "--help"]);
    expect(r).toEqual({ kind: "help", verb: "run" });
  });
});

describe("parseCli — ls and the --all mapping", () => {
  it("plain ls is lanes-only (all=false)", () => {
    expect(parseCli(["ls"])).toEqual({ kind: "ls", json: false, all: false });
  });

  it("--all includes interactive worktrees (all=true)", () => {
    expect(parseCli(["ls", "--all"])).toEqual({ kind: "ls", json: false, all: true });
  });

  it("--json maps through", () => {
    expect(parseCli(["ls", "--json"])).toEqual({ kind: "ls", json: true, all: false });
  });

  it("rejects a positional argument", () => {
    const r = parseCli(["ls", "extra"]);
    expect(r.kind).toBe("error");
  });
});

describe("parseDuration", () => {
  it("parses units and bare numbers", () => {
    expect(parseDuration("250")).toBe(250);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1.5s")).toBe(1500);
  });

  it("throws on garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
  });
});

describe("runCli — dispatch and exit-code passthrough", () => {
  it("surfaces runList's exit code and forwards the --all/--json mapping", async () => {
    const runListSpy = vi.fn(async () => ({ exitCode: 2 }));
    const out = collector();
    const err = collector();
    const code = await runCli(["ls", "--json", "--all"], {
      cwd: "/repo",
      out,
      err,
      runList: runListSpy,
    });
    expect(code).toBe(2);
    expect(runListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", json: true, all: true }),
    );
  });

  it("surfaces runHeadless's exit code and forwards resolved options", async () => {
    const runHeadlessSpy = vi.fn(async () => ({ exitCode: 1 }));
    const code = await runCli(
      ["run", "agetree/x", "--prompt", "hello", "--agent", "fake", "--base", "main", "--wait"],
      {
        cwd: "/repo",
        out: collector(),
        err: collector(),
        runHeadless: runHeadlessSpy,
      },
    );
    expect(code).toBe(1);
    expect(runHeadlessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        prompt: "hello",
        branch: "agetree/x",
        base: "main",
        adapter: "fake",
        wait: true,
        json: false,
      }),
    );
  });

  it("forwards --claude-model as the generic model when the adapter is claude", async () => {
    const runHeadlessSpy = vi.fn(async () => ({ exitCode: 0 }));
    await runCli(
      ["run", "--prompt", "hi", "--agent", "claude", "--claude-model", "sonnet"],
      { cwd: "/repo", out: collector(), err: collector(), runHeadless: runHeadlessSpy },
    );
    expect(runHeadlessSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "claude", model: "sonnet" }),
    );
  });

  it("forwards --amp-model (not --claude-model) when the adapter is amp", async () => {
    const runHeadlessSpy = vi.fn(async () => ({ exitCode: 0 }));
    await runCli(
      ["run", "--prompt", "hi", "--agent", "amp", "--amp-model", "fast", "--claude-model", "sonnet"],
      { cwd: "/repo", out: collector(), err: collector(), runHeadless: runHeadlessSpy },
    );
    expect(runHeadlessSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "amp", model: "fast" }),
    );
  });

  it("interactive run delegates to engine.runInteractive and returns its code", async () => {
    const runInteractive = vi.fn(async () => 42);
    const engine: Engine = {
      ensureWorktree: async () => ({ branch: "b", path: "/p" }),
      runInteractive,
      merge: async () => 0,
      remove: async () => 0,
    };
    const code = await runCli(["run", "ui-polish"], {
      cwd: "/repo",
      out: collector(),
      err: collector(),
      createEngine: () => engine,
    });
    expect(code).toBe(42);
    expect(runInteractive).toHaveBeenCalledWith("ui-polish");
  });

  it("stub verbs exit 2 with a not-implemented message on stderr", async () => {
    const out = collector();
    const err = collector();
    const code = await runCli(["logs", "feature-x"], { out, err });
    expect(code).toBe(2);
    expect(err.text).toMatch(/agetree logs: not implemented yet/);
    expect(out.text).toBe("");
  });

  it("errors exit 2 with diagnostics on stderr, nothing on stdout", async () => {
    const out = collector();
    const err = collector();
    const code = await runCli(["run", "--prompt", "x", "--prompt-file", "y"], { out, err });
    expect(code).toBe(2);
    expect(err.text).toMatch(/mutually exclusive/);
    expect(out.text).toBe("");
  });

  it("help exits 0 to stdout", async () => {
    const out = collector();
    const err = collector();
    const code = await runCli(["--help"], { out, err });
    expect(code).toBe(0);
    expect(out.text).toMatch(/usage: agetree/);
    expect(err.text).toBe("");
  });
});
