import { describe, expect, it } from "vitest";
import { CATEGORIES, evaluate, RULES } from "../../src/rules/engine.js";
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
  it("registers the four category modules; secret-access and exfiltration are empty placeholders", () => {
    expect(CATEGORIES).toEqual(["destructive", "file-tools", "secret-access", "exfiltration"]);
    expect(secretAccess).toEqual([]);
    expect(exfiltration).toEqual([]);
    expect(RULES.every((r) => r.category !== "secret-access" && r.category !== "exfiltration")).toBe(true);
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
