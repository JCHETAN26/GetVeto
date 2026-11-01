// `veto init --guard`, `veto mode`, `veto status` through the BUILT CLI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const cfg = (root: string) => JSON.parse(readFileSync(join(root, ".veto", "config.json"), "utf8"));

describe("veto init and .veto/config.json", () => {
  it("init creates a watch-mode config with the default actions", async () => {
    const root = tempProject();
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    expect(cfg(root)).toEqual({ mode: "watch", actions: { high: "deny", medium: "ask", low: "log" }, disabledRules: [] });
    expect(r.stdout).toContain("Veto installed (watch mode:");
  });

  it("init --guard creates guard mode; on an existing config it switches only the mode", async () => {
    const a = tempProject();
    expect((await runCli(["init", "--guard"], { cwd: a })).stdout).toContain("Veto installed (guard mode:");
    expect(cfg(a).mode).toBe("guard");

    const b = tempProject();
    mkdirSync(join(b, ".veto"));
    writeFileSync(join(b, ".veto", "config.json"), JSON.stringify({ mode: "watch", disabledRules: ["destructive/broad"] }));
    const r = await runCli(["init", "--guard"], { cwd: b });
    expect(r.stdout).toContain("(mode: watch -> guard)");
    expect(cfg(b)).toMatchObject({ mode: "guard", disabledRules: ["destructive/broad"] });
  });

  it("init never overwrites an invalid config; --guard then exits 1", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    writeFileSync(join(root, ".veto", "config.json"), "{ nope");
    const plain = await runCli(["init"], { cwd: root });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/warning: .*invalid JSON/);
    expect((await runCli(["init", "--guard"], { cwd: root })).code).toBe(1);
    expect(readFileSync(join(root, ".veto", "config.json"), "utf8")).toBe("{ nope");
  });
});

describe("veto mode", () => {
  it("shows the default, then sets guard and watch", async () => {
    const root = tempProject();
    expect((await runCli(["mode"], { cwd: root })).stdout).toMatch(/^mode: watch: .*\(default; no /);
    const g = await runCli(["mode", "guard"], { cwd: root });
    expect(g.code).toBe(0);
    expect(g.stdout).toContain("mode: watch -> guard");
    expect(cfg(root).mode).toBe("guard");
    expect((await runCli(["mode"], { cwd: root })).stdout).toContain("high -> deny, medium -> ask, low -> log");
    expect((await runCli(["mode", "guard"], { cwd: root })).stdout).toContain("already guard");
    await runCli(["mode", "watch"], { cwd: root });
    expect(cfg(root).mode).toBe("watch");
  });

  it("refuses to change an invalid config, and rejects unknown modes", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    writeFileSync(join(root, ".veto", "config.json"), JSON.stringify({ mode: "block" }));
    const r = await runCli(["mode", "guard"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not changing the mode: .*mode must be/);
    expect((await runCli(["mode"], { cwd: root })).stdout).toMatch(/^mode: watch \(config is invalid/);
    expect((await runCli(["mode", "block"], { cwd: tempProject() })).code).toBe(1);
  });

  it("the mode switch takes effect on the next hook call, no restart", async () => {
    const root = tempProject();
    await runCli(["init"], { cwd: root });
    const rm = loadFixtures().find((f) => f.name === "17-PreToolUse-Bash.json")!.raw.replaceAll("/REDACTED_PROJECT", root);
    const env = { CLAUDE_PROJECT_DIR: root };
    expect((await runCli(["hook"], { cwd: root, stdin: rm, env })).stdout).toBe("");
    await runCli(["mode", "guard"], { cwd: root });
    expect((await runCli(["hook"], { cwd: root, stdin: rm, env })).stdout).toContain('"permissionDecision":"ask"');
  });
});

describe("veto status", () => {
  it("mode, which settings file has the hook, config path, last 5 flags", async () => {
    const root = tempProject();
    await runCli(["init", "--guard"], { cwd: root });
    const real = loadFixtures();
    const rm = real.find((f) => f.name === "17-PreToolUse-Bash.json")!.raw.replaceAll("/REDACTED_PROJECT", root);
    for (let i = 0; i < 6; i++) await runCli(["hook"], { cwd: root, stdin: rm, env: { CLAUDE_PROJECT_DIR: root } });
    const r = await runCli(["status"], { cwd: root });
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/^mode: guard/);
    expect(out).toMatch(/\.claude\/settings\.local\.json\s+installed/);
    expect(out).toMatch(/\.claude\/settings\.json\s+no file/);
    expect(out).toContain(`config: ${join(root, ".veto", "config.json")}`);
    expect(out).toContain("(6 entries, 6 flagged)");
    expect(out).toContain("last 5 flags:");
    expect(out.split("\n").filter((l) => l.includes("? asked medium:"))).toHaveLength(5);
  });

  it("before init: says nothing is installed and no log yet", async () => {
    const r = await runCli(["status"], { cwd: tempProject() });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/settings\.local\.json\s+no file/);
    expect(r.stdout).toContain("not created yet; defaults apply");
    expect(r.stdout).toContain("log: none yet");
  });
});
