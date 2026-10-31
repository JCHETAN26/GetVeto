// init / uninstall / log through the BUILT CLI as a subprocess.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const LOCAL = join(".claude", "settings.local.json");
const SHARED = join(".claude", "settings.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const vetoGroup = { matcher: "*", hooks: [{ type: "command", command: "veto", args: ["hook"], timeout: 10 }] };

describe("veto init", () => {
  it("fresh project: creates settings.local.json, .veto/, .gitignore; prints what changed", async () => {
    const root = tempProject();
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    const s = readJson(join(root, LOCAL));
    expect(s).toEqual({ hooks: { PreToolUse: [vetoGroup], PostToolUse: [vetoGroup], PostToolUseFailure: [vetoGroup] } });
    expect(existsSync(join(root, SHARED))).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".veto/\n.claude/settings.local.json\n");
    expect(statSync(join(root, ".veto")).isDirectory()).toBe(true);
    expect(r.stdout).toContain(`created:  ${join(root, LOCAL)}`);
    expect(r.stdout).toContain("PreToolUse, PostToolUse, PostToolUseFailure");
    expect(r.stdout).toContain(".gitignore");
    expect(r.stdout).toContain(`created:   ${join(root, ".veto")}/`);
  });

  it("is idempotent: second run changes nothing and makes no backup", async () => {
    const root = tempProject();
    await runCli(["init"], { cwd: root });
    const before = readFileSync(join(root, LOCAL), "utf8");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing changed");
    expect(readFileSync(join(root, LOCAL), "utf8")).toBe(before);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gi);
    expect(existsSync(join(root, ".veto", "backups"))).toBe(false);
  });

  it("existing settings with other hooks: backs up, merges, keeps everything else", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    const original = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] },
    };
    const originalText = JSON.stringify(original, null, 4);
    writeFileSync(join(root, LOCAL), originalText);
    writeFileSync(join(root, ".gitignore"), "node_modules");
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    const s = readJson(join(root, LOCAL));
    expect(s.permissions).toEqual(original.permissions);
    expect(s.hooks.PreToolUse).toEqual([original.hooks.PreToolUse[0], vetoGroup]);
    const backups = readdirSync(join(root, ".veto", "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, ".veto", "backups", backups[0]!), "utf8")).toBe(originalText);
    expect(r.stdout).toContain("backup:");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.veto/\n.claude/settings.local.json\n");
  });

  it("--shared writes .claude/settings.json and doesn't gitignore it", async () => {
    const root = tempProject();
    const r = await runCli(["init", "--shared"], { cwd: root });
    expect(r.code).toBe(0);
    expect(readJson(join(root, SHARED)).hooks.PreToolUse).toEqual([vetoGroup]);
    expect(existsSync(join(root, LOCAL))).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".veto/\n");
  });

  it("refuses to touch a settings file with invalid JSON", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, LOCAL), "{ // comment\n}");
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(join(root, LOCAL), "utf8")).toBe("{ // comment\n}");
  });

  it("rejects unknown options", async () => {
    const r = await runCli(["init", "--global"], { cwd: tempProject() });
    expect(r.code).toBe(1);
  });
});

describe("veto uninstall", () => {
  it("removes a file Veto created; keeps .veto logs", async () => {
    const root = tempProject();
    await runCli(["init"], { cwd: root });
    const r = await runCli(["uninstall"], { cwd: root });
    expect(r.code).toBe(0);
    expect(existsSync(join(root, LOCAL))).toBe(false);
    expect(existsSync(join(root, ".veto"))).toBe(true);
    expect(r.stdout).toContain("deleted:");
  });

  it("restores pre-existing settings exactly (other hooks untouched)", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    const original = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } };
    writeFileSync(join(root, LOCAL), JSON.stringify(original));
    await runCli(["init"], { cwd: root });
    const r = await runCli(["uninstall"], { cwd: root });
    expect(r.code).toBe(0);
    expect(readJson(join(root, LOCAL))).toEqual(original);
    expect(r.stdout).toContain("modified:");
  });

  it("cleans BOTH local and shared files when both contain Veto", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, SHARED), JSON.stringify({ env: { A: "1" } }));
    await runCli(["init"], { cwd: root });
    await runCli(["init", "--shared"], { cwd: root });
    const r = await runCli(["uninstall"], { cwd: root });
    expect(r.code).toBe(0);
    expect(existsSync(join(root, LOCAL))).toBe(false);
    expect(readJson(join(root, SHARED))).toEqual({ env: { A: "1" } });
  });

  it("nothing installed: says so, exit 0", async () => {
    const r = await runCli(["uninstall"], { cwd: tempProject() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing changed");
  });
});

describe("veto log", () => {
  it("prints a readable timeline of what the hook recorded", async () => {
    const root = tempProject();
    const fixtures = loadFixtures();
    for (const f of fixtures) await runCli(["hook"], { cwd: root, stdin: f.raw, env: { CLAUDE_PROJECT_DIR: root } });
    const r = await runCli(["log", "-n", "50"], { cwd: root });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(fixtures.length + 1); // + footer
    fixtures.forEach((f, i) => {
      expect(lines[i]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  /);
      expect(lines[i]).toContain(String(f.event.tool_name ?? "-"));
    });
    const one = await runCli(["log", "-n", "1"], { cwd: root });
    expect(one.stdout.trim().split("\n")).toHaveLength(2);
  });

  it("no log yet: friendly message, exit 0", async () => {
    const r = await runCli(["log"], { cwd: tempProject() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No log yet");
  });

  it("bad -n: exit 1", async () => {
    expect((await runCli(["log", "-n", "zero"], { cwd: tempProject() })).code).toBe(1);
  });
});
