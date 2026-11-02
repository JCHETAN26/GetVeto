import { describe, expect, it } from "vitest";
import { allRules, CATEGORIES, evaluate, rulesFor } from "../../src/rules/engine.js";
import { rules as exfiltration } from "../../src/rules/exfiltration/index.js";
import { rules as secretAccess } from "../../src/rules/secret-access/index.js";
import type { Rule } from "../../src/rules/types.js";
import { loadFixtures } from "../helpers.js";

const root = "/home/alice/code/app";
const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root });

const flagEcho: Rule = {
  id: "test/echo",
  category: "destructive",
  check: (ctx) =>
    ctx.commands.filter((c) => c.program === "echo").map(() => ({ ruleId: "test/echo", category: "destructive", severity: "low", reason: "echo seen." })),
};

describe("rule engine", () => {
  it("registers the category modules", async () => {
    expect(CATEGORIES).toEqual(["destructive", "file-tools", "secret-access", "exfiltration", "self-protection"]);
    expect(secretAccess.map((r) => r.id)).toEqual(["secret-access/shell-read", "secret-access/env-dump"]);
    expect(exfiltration.map((r) => r.id)).toEqual(["exfiltration/network-send"]);
  });

  it("loads only the categories that apply to the tool", async () => {
    expect(new Set((await rulesFor("Bash")).map((r) => r.category))).toEqual(new Set(["destructive", "secret-access", "exfiltration", "self-protection"]));
    expect(new Set((await rulesFor("Edit")).map((r) => r.category))).toEqual(new Set(["file-tools", "self-protection"]));
    expect(new Set((await rulesFor("Read")).map((r) => r.category))).toEqual(new Set(["file-tools"]));
    expect(await rulesFor("Glob")).toEqual([]);
    expect(await rulesFor(undefined)).toEqual([]);
  });

  it("allow with no findings, flag with findings, and reports analysis time", async () => {
    const a = await evaluate(bash("npm test"), { projectRoot: root, rules: [flagEcho] });
    expect(a).toMatchObject({ verdict: "allow", findings: [] });
    expect(a.analysis_ms).toBeGreaterThanOrEqual(0);
    const f = await evaluate(bash("npm test && echo done"), { projectRoot: root, rules: [flagEcho] });
    expect(f.verdict).toBe("flag");
    expect(f.findings).toEqual([{ ruleId: "test/echo", category: "destructive", severity: "low", reason: "echo seen." }]);
  });

  it("passes parsed commands with the effective cwd to rules", async () => {
    let seen: (string | null)[] = [];
    const spy: Rule = { id: "t", category: "destructive", check: (ctx) => ((seen = ctx.commands.map((c) => c.cwd)), []) };
    await evaluate(bash("cd src && ls"), { projectRoot: root, rules: [spy] });
    expect(seen).toEqual([root, `${root}/src`]);
  });

  it("sorts findings most severe first", async () => {
    const two: Rule = {
      id: "t",
      category: "destructive",
      check: () => [
        { ruleId: "a", category: "destructive", severity: "low", reason: "a." },
        { ruleId: "b", category: "destructive", severity: "high", reason: "b." },
      ],
    };
    const v = await evaluate(bash("ls"), { projectRoot: root, rules: [two] });
    expect(v.findings.map((f) => f.ruleId)).toEqual(["b", "a"]);
  });

  it("a rule that throws gives verdict error, never an exception", async () => {
    const boom: Rule = { id: "t", category: "destructive", check: () => { throw new Error("boom"); } };
    const v = await evaluate(bash("ls"), { projectRoot: root, rules: [boom] });
    expect(v).toMatchObject({ verdict: "error", error: "boom", findings: [] });
  });

  it("odd payloads don't throw: missing tool_input, non-string command, non-Bash tools", async () => {
    for (const ev of [{}, { tool_name: "Bash" }, { tool_name: "Bash", tool_input: { command: 42 } }, { tool_name: "Read", tool_input: null }]) {
      expect((await evaluate(ev, { projectRoot: root })).verdict).toBe("allow");
    }
  });

  it("marks a command that doesn't parse as incomplete instead of failing", async () => {
    const v = await evaluate(bash("echo $("), { projectRoot: root, rules: [flagEcho] });
    expect(v.verdict).toBe("allow");
    expect(v.incomplete).toMatch(/did not parse/);
  });

  it("runs over every real fixture without error", async () => {
    for (const f of loadFixtures()) {
      const v = await evaluate(f.event, { projectRoot: String(f.event.cwd ?? root) });
      expect(v.verdict, f.name).not.toBe("error");
    }
  });
});

describe("parse prefilter (triggers)", () => {
  it("mayMention sees a program name however bash would spell it", async () => {
    const { mayMention } = await import("../../src/rules/engine.js");
    const yes = ["rm -rf dist", "/bin/rm x", "sudo rm -r y", "\\rm -rf z", "r''m -rf z", '"rm" -rf z', "r\\\nm -rf z", "$'\\x72m' -rf z", 'x=$(rm -r a)', "mkfs.ext4 /dev/sdb1", "git status", "a;rm -r b"];
    const no = ["npm test", "npm run format", "cat src/firmware.c", "ls -la", "node greet.js", "git-lfs ls-files", "add.sh"];
    for (const c of yes) expect(mayMention(c, ["rm", "git", "mkfs"]), c).toBe(true);
    for (const c of no) expect(mayMention(c, ["rm", "git", "mkfs"]), c).toBe(false);
  });

  it("a punctuation trigger such as \"<\" matches anywhere in the command", async () => {
    const { mayMention } = await import("../../src/rules/engine.js");
    expect(mayMention("wc -l<notes.txt", ["<"])).toBe(true);
    expect(mayMention("npm test", ["<", "cat"])).toBe(false);
    expect(mayMention("cat notes.txt", ["<", "cat"])).toBe(true);
  });

  it("skipping the parse never changes a verdict (same findings as checking every command)", async () => {
    const { allRules } = await import("../../src/rules/engine.js");
    const { parseCommand } = await import("../../src/shell/parse.js");
    const rules = (await allRules()).filter((r) => r.category === "destructive" || r.category === "secret-access");
    const commands = [
      "npm test", "ls -la", "cat notes.md", "rm -rf dist", "rm -rf ~", "r''m -rf ~", "\\rm -rf ~", '"rm" -rf src',
      "$'\\x72m' -rf ~", "git push -f origin main", "g\\it push -f origin main", "git reset --hard", "find ~ -delete",
      "chmod -R 777 ~", "sudo dd if=a.iso of=/dev/sdb", "mkfs.ext4 /dev/sdb1", "bash -c 'rm -rf ~'", "echo format",
      "printenv", "env | sort", "export -p",
      "cat .env", "/bin/cat .env", "wc -l < .env", "c''at .env", "git show HEAD:.env",
    ];
    for (const command of commands) {
      const viaEngine = await evaluate(bash(command), { projectRoot: root, home: "/home/alice" });
      const r = parseCommand(command, { cwd: root, home: "/home/alice" });
      const all = "commands" in r ? r.commands : [];
      const ctx = { event: bash(command), toolName: "Bash", toolInput: { command }, projectRoot: root, home: "/home/alice", cwd: root, commands: all, gitStatus: () => null };
      const direct = rules.flatMap((x) => x.check(ctx));
      expect(viaEngine.findings.length, command).toBe(direct.length);
      if (["r''m -rf ~", "\\rm -rf ~", "$'\\x72m' -rf ~", "g\\it push -f origin main"].includes(command)) {
        expect(viaEngine.verdict, `obfuscated spelling still flagged: ${command}`).toBe("flag");
      }
    }
  });
});

describe("suggestions", () => {
  it("every medium or high finding offers a safer alternative", async () => {
    const cmds = [
      "rm -rf ~/Downloads", "rm -rf src", "rm -rf $X", "git reset --hard", "git checkout .", "git clean -fdx",
      "git push -f origin main", "git push -f origin feature/x", "git push --mirror backup", "find ~ -delete",
      "chmod -R 777 ~", "dd if=a.iso of=/dev/sdb", "mkfs.ext4 /dev/sdb1", "rm ~/notes.txt", "mv ~/a.txt ./src/",
    ];
    const tools: [string, Record<string, unknown>][] = [["Write", { file_path: "/etc/hosts" }], ["Read", { file_path: `${root}/.env` }]];
    const events = [...cmds.map(bash), ...tools.map(([tool_name, tool_input]) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: root }))];
    let checked = 0;
    for (const ev of events) {
      const v = await evaluate(ev, { projectRoot: root, home: "/home/alice" });
      expect(v.verdict, JSON.stringify(ev.tool_input)).toBe("flag");
      for (const f of v.findings.filter((x) => x.severity !== "low")) {
        expect(f.suggestion, `${f.ruleId}: ${f.reason}`).toMatch(/^[A-Z].*\.$/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(events.length);
  });
});
