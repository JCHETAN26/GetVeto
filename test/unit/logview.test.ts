import { describe, expect, it } from "vitest";
import { formatEntry, parseLog, summarizeInput } from "../../src/logview.js";

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
