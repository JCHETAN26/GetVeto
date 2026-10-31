import { describe, expect, it } from "vitest";
import { formatLogLine, parseEvent, resolveProjectRoot } from "../../src/hook.js";

describe("parseEvent", () => {
  it("accepts a JSON object", () => {
    const r = parseEvent('{"hook_event_name":"PreToolUse","tool_name":"Bash"}');
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  });
  it("accepts surrounding whitespace / trailing newline", () => {
    expect(parseEvent('\n  {"a":1}\n').ok).toBe(true);
  });
  it.each([
    ["", "empty stdin"],
    ["   \n", "empty stdin"],
    ["{not json", "invalid JSON"],
    ["[1,2]", "not a JSON object"],
    ['"str"', "not a JSON object"],
    ["null", "not a JSON object"],
    ["42", "not a JSON object"],
  ])("rejects %j", (raw, msg) => {
    const r = parseEvent(raw);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(msg);
  });
});

describe("resolveProjectRoot", () => {
  it("prefers CLAUDE_PROJECT_DIR", () => {
    expect(resolveProjectRoot({ CLAUDE_PROJECT_DIR: "/p" }, { cwd: "/c" }, "/f")).toBe("/p");
  });
  it("falls back to event.cwd, then process cwd", () => {
    expect(resolveProjectRoot({}, { cwd: "/c" }, "/f")).toBe("/c");
    expect(resolveProjectRoot({}, {}, "/f")).toBe("/f");
    expect(resolveProjectRoot({ CLAUDE_PROJECT_DIR: "" }, { cwd: 5 }, "/f")).toBe("/f");
  });
});

describe("formatLogLine", () => {
  it("is exactly one JSON line with ts + the untouched event", () => {
    const event = { x: { nested: [1, "two\nlines"] } };
    const line = formatLogLine(event, new Date("2026-01-02T03:04:05.000Z"));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ ts: "2026-01-02T03:04:05.000Z", event });
  });
});
