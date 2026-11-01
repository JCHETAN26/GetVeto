import { describe, expect, it } from "vitest";
import { formatEntry, parseLog, summarizeInput, verdictSuffix } from "../../src/logview.js";

describe("summarizeInput", () => {
  it.each([
    ["Bash", { command: "ls -la\n  && git status" }, "ls -la && git status"],
    ["Read", { file_path: "/p/a.txt", offset: 3 }, "/p/a.txt"],
    ["Edit", { file_path: "/p/b.ts", old_string: "a", new_string: "b" }, "/p/b.ts"],
    ["Write", { file_path: "/p/c.md", content: "x" }, "/p/c.md"],
    ["Glob", { pattern: "**/*.ts", path: "/p" }, "**/*.ts in /p"],
    ["Grep", { pattern: "TODO" }, '"TODO"'],
    ["WebFetch", { url: "https://e.com", prompt: "p" }, "https://e.com"],
    ["WebSearch", { query: "veto" }, "veto"],
    ["Agent", { description: "explore", prompt: "long" }, "explore"],
    ["mcp__x__y", { q: "hello", n: 1 }, "hello"],
  ])("%s", (tool, input, expected) => {
    expect(summarizeInput(tool, input)).toBe(expected);
  });
  it("truncates long input to one line", () => {
    const s = summarizeInput("Bash", { command: "x".repeat(500) });
    expect(s.length).toBe(100);
    expect(s.endsWith("…")).toBe(true);
  });
  it("tolerates missing / odd input", () => {
    expect(summarizeInput("Bash", undefined)).toBe("");
    expect(summarizeInput(undefined, { a: 1 })).toBe('{"a":1}');
  });
});

describe("parseLog / formatEntry", () => {
  it("skips malformed lines and counts them", () => {
    const text = [
      JSON.stringify({ ts: "2026-10-31T12:00:00.000Z", event: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } }),
      "garbage",
      JSON.stringify({ nope: 1 }),
      "",
    ].join("\n");
    const { entries, malformed } = parseLog(text);
    expect(entries).toHaveLength(1);
    expect(malformed).toBe(2);
    const line = formatEntry(entries[0]!);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  pre   Bash\s+ls$/);
  });
  it("shows failure errors", () => {
    const line = formatEntry({
      ts: "2026-10-31T12:00:00.000Z",
      event: { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "false" }, error: "Exit code 1\nmore" },
    });
    expect(line).toContain("FAIL");
    expect(line).toContain("[error: Exit code 1]");
  });
});

describe("UserPromptSubmit lines", () => {
  it("shows the prompt text", () => {
    const line = formatEntry({
      ts: "2026-10-31T12:00:00.000Z",
      event: { hook_event_name: "UserPromptSubmit", prompt: "fix the bug\nin ISSUE-42", prompt_id: "p1" },
    });
    expect(line).toMatch(/  user  prompt      fix the bug in ISSUE-42$/);
  });
});

describe("verdict markers (watch mode)", () => {
  const base = { ts: "2026-01-02T03:04:05.000Z", event: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push -f origin main" } } };
  it("flag: ⚑ + most severe finding + count of the rest", () => {
    const e = { ...base, verdict: "flag", findings: [{ severity: "high", reason: "Force push to main rewrites shared history." }, { severity: "low", reason: "x." }] };
    expect(verdictSuffix(e)).toBe("  ⚑ high: Force push to main rewrites shared history. (+1 more)");
    expect(formatEntry(e)).toMatch(/git push -f origin main  ⚑ high: /);
  });
  it("allow and old entries without a verdict: no marker; error: ⚠", () => {
    expect(verdictSuffix({ ...base, verdict: "allow", findings: [] })).toBe("");
    expect(verdictSuffix(base)).toBe("");
    expect(verdictSuffix({ ...base, verdict: "error", error: "boom" })).toBe("  ⚠ analysis error: boom");
  });
});
