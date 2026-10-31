import { describe, expect, it } from "vitest";
import { HOME_PLACEHOLDER, redactString, redactValue, SECRET_PLACEHOLDER } from "../../src/redact.js";

const opts = { homeDir: "/home/alice", username: "alice" };

describe("redaction", () => {
  it("replaces the home dir and the dashed project-dir encoding", () => {
    expect(redactString("/home/alice/proj/a.txt", opts)).toBe(`${HOME_PLACEHOLDER}/proj/a.txt`);
    expect(redactString("/home/alice", opts)).toBe(HOME_PLACEHOLDER);
    expect(redactString("/home/alicex/a", opts)).toBe("/home/alicex/a"); // different user
    expect(redactString("/x/.claude/projects/-home-alice-proj/s.jsonl", opts)).toBe(
      "/x/.claude/projects/-home-REDACTED_USER-proj/s.jsonl",
    );
  });

  it.each([
    "AKIAABCDEFGHIJKLMNOP",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ])("redacts token %s", (tok) => {
    expect(redactString(`echo ${tok} done`, opts)).toBe(`echo ${SECRET_PLACEHOLDER} done`);
  });

  it("redacts sensitive assignments but keeps the key", () => {
    expect(redactString("API_KEY=supersecretvalue", opts)).toBe(`API_KEY=${SECRET_PLACEHOLDER}`);
    expect(redactString('"password": "hunter22"', opts)).toBe(`"password": "${SECRET_PLACEHOLDER}"`);
    expect(redactString("postgres://bob:pa55word@db:5432/x", opts)).toBe(`${SECRET_PLACEHOLDER}db:5432/x`);
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("git status && ls -la", opts)).toBe("git status && ls -la");
  });

  it("deep-redacts nested values without changing shape", () => {
    const v = redactValue({ a: ["/home/alice/x", 3, null, { token: "TOKEN=abcdefgh123" }] }, opts);
    expect(v).toEqual({ a: [`${HOME_PLACEHOLDER}/x`, 3, null, { token: `TOKEN=${SECRET_PLACEHOLDER}` }] });
  });
});
