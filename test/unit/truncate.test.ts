import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLogLine } from "../../src/hook.js";
import { COMMAND_MAX_BYTES, MAX_BYTES, TRUNCATION_MARKER_RE, truncateEvent, truncateString } from "../../src/truncate.js";
import { REPO } from "../helpers.js";

// Real captured payloads (test/fixtures/real). Their own contents are tiny, so the tests below
// keep the REAL structure and only swap in an oversized string value where a big file would go.
const realRead = JSON.parse(readFileSync(join(REPO, "test/fixtures/real/12-PostToolUse-Read.json"), "utf8"));
const realBash = JSON.parse(readFileSync(join(REPO, "test/fixtures/real/10-PostToolUse-Bash.json"), "utf8"));
const realEdit = JSON.parse(readFileSync(join(REPO, "test/fixtures/real/14-PostToolUse-Edit.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("truncateString", () => {
  it("leaves strings at or under the limit alone", () => {
    expect(truncateString("a".repeat(MAX_BYTES), MAX_BYTES)).toEqual({ value: "a".repeat(MAX_BYTES), truncated: false });
  });
  it("keeps the first 4 KB and appends length + sha256 of the FULL value", () => {
    const big = "x".repeat(10_000);
    const r = truncateString(big, MAX_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.value.startsWith("x".repeat(MAX_BYTES))).toBe(true);
    const m = r.value.match(TRUNCATION_MARKER_RE)!;
    expect(Number(m[1])).toBe(10_000);
    expect(m[2]).toBe(sha(big));
  });
  it("never splits a multi-byte character", () => {
    const big = "é".repeat(5000); // 2 bytes each
    const r = truncateString(big, MAX_BYTES);
    const head = r.value.replace(TRUNCATION_MARKER_RE, "");
    expect(head).toBe("é".repeat(MAX_BYTES / 2));
    expect(head.includes("�")).toBe(false);
    const emoji = "a" + "😀".repeat(2000); // 4-byte chars, offset by 1 so the cut lands mid-char
    const h2 = truncateString(emoji, MAX_BYTES).value.replace(TRUNCATION_MARKER_RE, "");
    expect(h2.includes("�")).toBe(false);
    expect(bytes(h2)).toBeLessThanOrEqual(MAX_BYTES);
  });
});

describe("truncateEvent on real captured fixtures", () => {
  it("real Read fixture unchanged as captured (content is small)", () => {
    const r = truncateEvent(realRead);
    expect(r.truncated).toEqual([]);
    expect(r.event).toBe(realRead);
  });

  it("real Read structure with a 1 MB file: only tool_response.file.content is capped", () => {
    const content = "line of a big file\n".repeat(55_000);
    const event = structuredClone(realRead);
    event.tool_response.file.content = content;
    const r = truncateEvent(event);
    expect(r.truncated).toEqual(["tool_response.file.content"]);
    const capped = (r.event as any).tool_response.file.content as string;
    expect(capped.startsWith(content.slice(0, MAX_BYTES))).toBe(true);
    expect(capped).toMatch(TRUNCATION_MARKER_RE);
    expect(capped.match(TRUNCATION_MARKER_RE)![2]).toBe(sha(content));
    expect(bytes(capped)).toBeLessThan(MAX_BYTES + 200);
    // Everything else is identical to the real capture.
    const rest = structuredClone(r.event) as any;
    rest.tool_response.file.content = realRead.tool_response.file.content;
    expect(rest).toEqual(realRead);
    expect(event.tool_response.file.content).toBe(content); // input not mutated
  });

  it("real Edit structure: big originalFile capped, file_path untouched", () => {
    const event = structuredClone(realEdit);
    event.tool_response.originalFile = "y".repeat(50_000);
    const r = truncateEvent(event);
    expect(r.truncated).toEqual(["tool_response.originalFile"]);
    expect((r.event as any).tool_input.file_path).toBe(realEdit.tool_input.file_path);
  });

  it("real Bash structure: command kept up to 16 KB, stdout capped at 4 KB", () => {
    const event = structuredClone(realBash);
    const cmd12k = "echo " + "a".repeat(12_000);
    event.tool_input.command = cmd12k;
    event.tool_response.stdout = "o".repeat(9_000);
    const r = truncateEvent(event);
    expect((r.event as any).tool_input.command).toBe(cmd12k); // 12 KB < 16 KB: untouched
    expect(r.truncated).toEqual(["tool_response.stdout"]);

    const event2 = structuredClone(realBash);
    event2.tool_input.command = "b".repeat(40_000);
    const r2 = truncateEvent(event2);
    expect(r2.truncated).toContain("tool_input.command");
    const c = (r2.event as any).tool_input.command as string;
    expect(c.startsWith("b".repeat(COMMAND_MAX_BYTES))).toBe(true);
    expect(c.replace(TRUNCATION_MARKER_RE, "")).toHaveLength(COMMAND_MAX_BYTES);
  });

  it("the 16 KB allowance is only for the Bash/PowerShell command, not other tools' fields", () => {
    const event = structuredClone(realRead);
    event.tool_input.command = "z".repeat(8_000); // not a shell tool
    expect(truncateEvent(event).truncated).toEqual(["tool_input.command"]);
  });

  it("formatLogLine records which paths were truncated", () => {
    const event = structuredClone(realRead);
    event.tool_response.file.content = "q".repeat(20_000);
    const entry = JSON.parse(formatLogLine(event, new Date("2026-11-01T00:00:00Z")));
    expect(entry.truncated).toEqual(["tool_response.file.content"]);
    expect(entry.event.session_id).toBe(realRead.session_id);
    const plain = JSON.parse(formatLogLine(realRead, new Date()));
    expect(plain.truncated).toBeUndefined();
  });
});

describe("UserPromptSubmit prompt cap", () => {
  it("keeps prompts up to 16 KB, caps longer ones", () => {
    const small = { hook_event_name: "UserPromptSubmit", prompt: "p".repeat(10_000) };
    expect(truncateEvent(small).truncated).toEqual([]);
    const big = { hook_event_name: "UserPromptSubmit", prompt: "p".repeat(50_000) };
    const r = truncateEvent(big);
    expect(r.truncated).toEqual(["prompt"]);
    expect((r.event.prompt as string).replace(TRUNCATION_MARKER_RE, "")).toHaveLength(COMMAND_MAX_BYTES);
  });
});
