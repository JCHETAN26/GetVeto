// init / uninstall / log through the BUILT CLI as a subprocess.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { CLI, loadFixtures, REPO, runCli, tempProject } from "../helpers.js";

const LOCAL = join(".claude", "settings.local.json");
const SHARED = join(".claude", "settings.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
// Local settings get absolute paths (node binary + this repo's built CLI); --shared stays portable.
const localHandler = { type: "command", command: process.execPath, args: [CLI, "hook"], timeout: 10 };
const vetoGroup = { matcher: "*", hooks: [localHandler] };
const portableHandler = { type: "command", command: "veto", args: ["hook"], timeout: 10 };
const sharedGroup = { matcher: "*", hooks: [portableHandler] };

describe("veto init", () => {
  it("fresh project: creates settings.local.json, .veto/, .gitignore; prints what changed", async () => {
    const root = tempProject();
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    const s = readJson(join(root, LOCAL));
    expect(s).toEqual({
      hooks: {
        PreToolUse: [vetoGroup],
        PostToolUse: [vetoGroup],
        PostToolUseFailure: [vetoGroup],
        UserPromptSubmit: [{ hooks: [localHandler] }], // no matcher: this event doesn't support one
      },
    });
    expect(existsSync(join(root, SHARED))).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".veto/\n.claude/settings.local.json\n");
    expect(statSync(join(root, ".veto")).isDirectory()).toBe(true);
    expect(r.stdout).toContain(`created:  ${join(root, LOCAL)}`);
    expect(r.stdout).toContain("PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit");
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
    expect(readJson(join(root, SHARED)).hooks.PreToolUse).toEqual([sharedGroup]);
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

describe("veto init: absolute paths (PATH robustness)", () => {
  it("writes the absolute node binary and absolute CLI path", async () => {
    const root = tempProject();
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    const h = readJson(join(root, LOCAL)).hooks.PreToolUse[0].hooks[0];
    expect(h.command).toBe(process.execPath);
    expect(h.args).toEqual([CLI, "hook"]);
    expect(h.command.startsWith("/") || /^[A-Za-z]:\\/.test(h.command)).toBe(true);
    expect(r.stdout).toContain(`hook command: ${process.execPath}`);
  });

  it("the installed command works with an EMPTY PATH (like a desktop/IDE launch without nvm)", async () => {
    const root = tempProject();
    await runCli(["init"], { cwd: root });
    const h = readJson(join(root, LOCAL)).hooks.PreToolUse[0].hooks[0];
    const payload = loadFixtures()[0]!.raw;
    // Spawn exactly what Claude Code would (exec form: command + args, no shell), with no PATH.
    const res = spawnSync(h.command, h.args, {
      input: payload,
      env: { CLAUDE_PROJECT_DIR: root, PATH: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(readFileSync(join(root, ".veto", "log.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    // Contrast: the old relative form can't even start without PATH.
    const old = spawnSync("veto", ["hook"], { input: payload, env: { PATH: "" } });
    expect((old.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("upgrades an old relative-path entry IN PLACE, keeping neighbors and order; then idempotent", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    const guard = { type: "command", command: "./guard.sh" };
    const old = {
      model: "m",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [guard] },
          { matcher: "*", hooks: [portableHandler] },
          { matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] },
        ],
        PostToolUse: [{ matcher: "*", hooks: [portableHandler] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [portableHandler] }],
      },
    };
    writeFileSync(join(root, LOCAL), JSON.stringify(old, null, 2));
    const r = await runCli(["init"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("upgraded existing Veto entry in place: PreToolUse, PostToolUse, PostToolUseFailure");
    expect(r.stdout).toContain('added to: UserPromptSubmit'); // Task #1 installs lacked it
    expect(r.stdout).toContain("backup:");
    const s = readJson(join(root, LOCAL));
    expect(s.model).toBe("m");
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [guard] },
      { matcher: "*", hooks: [localHandler] }, // same position as before
      { matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] },
    ]);
    expect(s.hooks.PostToolUse).toEqual([vetoGroup]);

    const before = readFileSync(join(root, LOCAL), "utf8");
    const again = await runCli(["init"], { cwd: root });
    expect(again.stdout).toContain("Nothing changed");
    expect(readFileSync(join(root, LOCAL), "utf8")).toBe(before);
  });

  it("upgrades an absolute entry pointing at an OLD install location (e.g. repo moved)", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    const moved = { type: "command", command: "/old/node", args: ["/media/x/project/GetVeto/dist/cli.js", "hook"], timeout: 10 };
    writeFileSync(join(root, LOCAL), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [moved] }] } }));
    await runCli(["init"], { cwd: root });
    const s = readJson(join(root, LOCAL));
    expect(s.hooks.PreToolUse).toEqual([vetoGroup]);
  });

  it("uninstall removes the absolute form too", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, LOCAL), JSON.stringify({ env: { A: "1" } }));
    await runCli(["init"], { cwd: root });
    await runCli(["uninstall"], { cwd: root });
    expect(readJson(join(root, LOCAL))).toEqual({ env: { A: "1" } });
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

  it("no Veto folder here or above: says so, without telling you to init here (exit 0)", async () => {
    const dir = tempProject();
    const r = await runCli(["log"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`No Veto log found in ${dir} or any folder above it. Run \`veto log\` inside a project where you ran \`veto init\`, or use --file <log.jsonl>.\n`);
    // From a home directory with no .veto: the same message (it used to say "Run `veto init` here").
    const home = tempProject("veto-home-");
    expect((await runCli(["log"], { cwd: home, env: { HOME: home } })).stdout).not.toMatch(/init` here/);
  });

  it("a .veto folder without a log yet: friendly message, exit 0", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    const r = await runCli(["log"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`No log yet at ${join(root, ".veto", "log.jsonl")}`);
  });

  it("finds the nearest .veto folder above the current directory, like git", async () => {
    const root = tempProject();
    const bash = loadFixtures().find((f) => f.name === "07-PreToolUse-Bash.json")!;
    await runCli(["hook"], { cwd: root, stdin: bash.raw.replaceAll("/REDACTED_PROJECT", root), env: { CLAUDE_PROJECT_DIR: root } });
    const deep = join(root, "src", "lib");
    mkdirSync(deep, { recursive: true });
    const r = await runCli(["log"], { cwd: deep });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git status");
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`-- 1 of 1 entries from ${join(root, ".veto", "log.jsonl")}`);
    // a nested project with its own .veto wins over the outer one
    const inner = join(root, "src");
    mkdirSync(join(inner, ".veto"));
    expect((await runCli(["log"], { cwd: deep })).stdout).toContain(`No log yet at ${join(inner, ".veto", "log.jsonl")}`);
  });

  it("an entry with no event name prints that (not \"?  -\"); an unknown event prints its name", async () => {
    const root = tempProject();
    // What a hand-run `echo '{}' | veto hook` logs: the real hook path, real output.
    await runCli(["hook"], { cwd: root, stdin: "{}", env: { CLAUDE_PROJECT_DIR: root } });
    await runCli(["hook"], { cwd: root, stdin: '{"session_id":"s1","cwd":"/x"}', env: { CLAUDE_PROJECT_DIR: root } });
    // A log line (not a hook payload) for an event name this version has no label for.
    writeFileSync(join(root, ".veto", "log.jsonl"), '{"ts":"2026-11-01T06:45:43.000Z","event":{"hook_event_name":"SomeFutureEvent"}}\n', { flag: "a" });
    const lines = (await runCli(["log"], { cwd: root })).stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  \(no event name\)  empty payload \{\}$/);
    expect(lines[1]).toMatch(/  \(no event name\)  fields: session_id, cwd$/);
    expect(lines[1]).not.toContain("s1"); // names only, never values
    expect(lines[2]).toMatch(/  SomeFutureEvent  -  /);
    expect(lines.slice(0, 3).join("\n")).not.toMatch(/  \?  -/);
  });

  it("bad -n: exit 1", async () => {
    expect((await runCli(["log", "-n", "zero"], { cwd: tempProject() })).code).toBe(1);
  });

  it("--file reads a saved log from anywhere (absolute or relative), with --flagged and -n", async () => {
    // Record real captured fixtures in one project, then move the log aside like a saved copy.
    const root = tempProject();
    const fixtures = loadFixtures();
    for (const f of fixtures) await runCli(["hook"], { cwd: root, stdin: f.raw.replaceAll("/REDACTED_PROJECT", root), env: { CLAUDE_PROJECT_DIR: root } });
    const elsewhere = tempProject();
    const saved = join(elsewhere, "saved-log.jsonl");
    writeFileSync(saved, readFileSync(join(root, ".veto", "log.jsonl")));
    const other = tempProject(); // no .veto here

    const all = await runCli(["log", "--file", saved, "-n", "100"], { cwd: other });
    expect(all.code).toBe(0);
    const lines = all.stdout.trim().split("\n");
    expect(lines).toHaveLength(fixtures.length + 1);
    expect(lines.at(-1)).toBe(`-- ${fixtures.length} of ${fixtures.length} entries from ${saved}`);

    const rel = await runCli(["log", "--file", "saved-log.jsonl", "-n", "1"], { cwd: elsewhere });
    expect(rel.code).toBe(0);
    expect(rel.stdout.trim().split("\n")).toHaveLength(2);

    // 17-PreToolUse-Bash.json is the real home-folder rm, which must flag (real-expected.json).
    const flagged = await runCli(["log", "--file", saved, "--flagged"], { cwd: other });
    expect(flagged.code).toBe(0);
    expect(flagged.stdout).toContain("rm -- ~/veto-test-junk/fake1.txt");
    expect(flagged.stdout).toContain("⚑ medium: rm deletes a file in your home directory (~/veto-test-junk/fake1.txt). (+1 more)");

    // --verbose: every finding on its own line, no "(+1 more)"
    const verbose = await runCli(["log", "--file", saved, "--flagged", "--verbose"], { cwd: other });
    expect(verbose.code).toBe(0);
    expect(verbose.stdout).not.toContain("(+1 more)");
    expect(verbose.stdout).toContain("\n      medium destructive/delete-outside-project: rm deletes a file in your home directory (~/veto-test-junk/fake1.txt).\n");
    expect(verbose.stdout).toContain("\n      medium destructive/delete-outside-project: rm deletes a file in your home directory (~/veto-test-junk/fake2.txt).\n");
  });

  it("--file errors: missing file or a directory exit 1; --file without a path is a usage error", async () => {
    const dir = tempProject();
    const missing = await runCli(["log", "--file", join(dir, "nope.jsonl")], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`veto: no log file at ${join(dir, "nope.jsonl")}`);
    expect(missing.stdout).toBe("");
    expect((await runCli(["log", "--file", dir], { cwd: dir })).code).toBe(1);
    const noArg = await runCli(["log", "--file"], { cwd: dir });
    expect(noArg.code).toBe(1);
    expect(noArg.stderr).toContain("--file expects a path");
  });

  it("marks flagged calls with ⚑ severity: reason; --flagged shows only those", async () => {
    // Real captured Bash payloads; one has its command value replaced (shape unchanged).
    const root = tempProject();
    const expectedFlags = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "real-expected.json"), "utf8")) as Record<string, unknown>;
    const bash = loadFixtures().filter((f) => f.event.hook_event_name === "PreToolUse" && f.event.tool_name === "Bash" && !(f.name in expectedFlags));
    const place = (raw: string) => raw.replaceAll("/REDACTED_PROJECT", root);
    for (const f of bash) await runCli(["hook"], { cwd: root, stdin: place(f.raw), env: { CLAUDE_PROJECT_DIR: root } });
    const flagged = JSON.parse(place(bash[0]!.raw)) as { tool_input: Record<string, unknown> };
    flagged.tool_input.command = "rm -rf ~/Downloads";
    await runCli(["hook"], { cwd: root, stdin: JSON.stringify(flagged), env: { CLAUDE_PROJECT_DIR: root } });

    const all = (await runCli(["log", "-n", "50"], { cwd: root })).stdout.trim().split("\n");
    expect(all).toHaveLength(bash.length + 2);
    expect(all.filter((l) => l.includes("⚑"))).toHaveLength(1);
    expect(all.at(-2)).toContain("rm -rf ~/Downloads  ⚑ high: Recursive delete of your home directory (~/Downloads).");

    const only = await runCli(["log", "--flagged"], { cwd: root });
    expect(only.code).toBe(0);
    const lines = only.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("⚑ high:");
    expect(lines[1]).toMatch(new RegExp(`^-- 1 of 1 flagged \\(${bash.length + 1} total\\) entries`));
  });
});
