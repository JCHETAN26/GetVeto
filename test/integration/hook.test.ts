// Spawns the BUILT CLI (dist/cli.js). Run `npm test`, which builds first.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const fixtures = loadFixtures();
const source = fixtures[0]?.source;
console.log(`[integration] using ${fixtures.length} ${source === "real" ? "REAL captured" : "DOCS-verbatim"} fixture(s)`);

function readLog(root: string) {
  return readFileSync(join(root, ".veto", "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { ts: string; event: unknown });
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe(`veto hook with ${source} fixtures`, () => {
  it("has fixtures to run", () => expect(fixtures.length).toBeGreaterThan(0));

  it.each(fixtures.map((f) => [f.name, f] as const))("%s: exit 0, empty stdout, logged verbatim", async (_n, f) => {
    const root = tempProject();
    const r = await runCli(["hook"], { cwd: root, stdin: f.raw, env: { CLAUDE_PROJECT_DIR: root } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(""); // no decision => normal permission flow
    const log = readLog(root);
    expect(log).toHaveLength(1);
    expect(log[0]!.event).toEqual(f.event);
    expect(Number.isNaN(Date.parse(log[0]!.ts))).toBe(false);
    expect(existsSync(join(root, ".veto", "errors.log"))).toBe(false);
  });

  it("appends one line per call, in order", async () => {
    const root = tempProject();
    for (const f of fixtures) {
      await runCli(["hook"], { cwd: root, stdin: f.raw, env: { CLAUDE_PROJECT_DIR: root } });
    }
    expect(readLog(root).map((e) => e.event)).toEqual(fixtures.map((f) => f.event));
  });

  it("without CLAUDE_PROJECT_DIR, logs under the process cwd when event.cwd is absent", async () => {
    const root = tempProject();
    const r = await runCli(["hook"], { cwd: root, stdin: '{"hook_event_name":"PreToolUse"}' });
    expect(r.code).toBe(0);
    expect(readLog(root)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("creates .veto/ as 0700 and files as 0600", async () => {
    const root = tempProject();
    await runCli(["hook"], { cwd: root, stdin: fixtures[0]!.raw, env: { CLAUDE_PROJECT_DIR: root } });
    expect(statSync(join(root, ".veto")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, ".veto", "log.jsonl")).mode & 0o777).toBe(0o600);
    await runCli(["hook"], { cwd: root, stdin: "garbage", env: { CLAUDE_PROJECT_DIR: root } });
    expect(statSync(join(root, ".veto", "errors.log")).mode & 0o777).toBe(0o600);
  });
});

describe("veto hook robustness (fail open)", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["empty stdin", ""],
    ["JSON array", "[1,2,3]"],
    ["binary junk", "\u0000\u0001�"],
  ])("%s: exit 0, empty stdout, error recorded, nothing logged", async (_label, input) => {
    const root = tempProject();
    const r = await runCli(["hook"], { cwd: root, stdin: input, env: { CLAUDE_PROJECT_DIR: root } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(root, ".veto", "log.jsonl"))).toBe(false);
    expect(readFileSync(join(root, ".veto", "errors.log"), "utf8")).toMatch(/hook: /);
  });

  it.skipIf(isRoot || process.platform === "win32")("unwritable .veto directory: still exit 0, no hang", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".veto"), { mode: 0o500 });
    chmodSync(join(root, ".veto"), 0o500);
    try {
      const r = await runCli(["hook"], { cwd: root, stdin: fixtures[0]!.raw, env: { CLAUDE_PROJECT_DIR: root } });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/veto: .*EACCES/); // last-resort error channel (debug log only)
      expect(r.ms).toBeLessThan(2000);
    } finally {
      chmodSync(join(root, ".veto"), 0o700);
    }
  });

  it(".veto exists as a regular file: still exit 0", async () => {
    const root = tempProject();
    writeFileSync(join(root, ".veto"), "not a dir");
    const r = await runCli(["hook"], { cwd: root, stdin: fixtures[0]!.raw, env: { CLAUDE_PROJECT_DIR: root } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("CLAUDE_PROJECT_DIR points to a nonexistent path under /proc: fails open fast", async () => {
    const root = tempProject();
    const r = await runCli(["hook"], {
      cwd: root,
      stdin: fixtures[0]!.raw,
      env: { CLAUDE_PROJECT_DIR: "/proc/definitely/not/writable" },
      killAfterMs: 8000,
    });
    // Regression: recursive mkdirSync used to hang forever here (Node 22.14).
    expect(r.signal).toBeNull();
    expect(r.ms).toBeLessThan(2000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("stdin never closed: gives up after its 2s guard and exits 0 (no hang)", async () => {
    const root = tempProject();
    const r = await runCli(["hook"], { cwd: root, stdin: null, env: { CLAUDE_PROJECT_DIR: root }, killAfterMs: 8000 });
    expect(r.signal).toBeNull(); // not killed by our 8s safety net
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(5000);
    expect(readFileSync(join(root, ".veto", "errors.log"), "utf8")).toContain("stdin not closed");
  });

  it("large payload (5 MB) is logged", async () => {
    const root = tempProject();
    const big = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { content: "x".repeat(5_000_000) } });
    const r = await runCli(["hook"], { cwd: root, stdin: big, env: { CLAUDE_PROJECT_DIR: root } });
    expect(r.code).toBe(0);
    expect(readLog(root)).toHaveLength(1);
  });
});
