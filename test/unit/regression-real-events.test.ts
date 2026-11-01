// Regression tests built from real captured events (test/fixtures/real/).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/rules/engine.js";
import { REPO } from "../helpers.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "real", name), "utf8")) as Record<string, unknown>;

describe("regression: real events", () => {
  it("2026-10-31 19:53:36: rm -- of two files in ~/veto-test-junk is flagged (was allow)", async () => {
    const ev = fixture("17-PreToolUse-Bash.json");
    expect((ev.tool_input as { command: string }).command).toBe("rm -- ~/veto-test-junk/fake1.txt ~/veto-test-junk/fake2.txt && ls -la ~/veto-test-junk");
    const v = await evaluate(ev, { projectRoot: String(ev.cwd), home: "/home/REDACTED_USER" });
    expect(v.verdict).toBe("flag");
    expect(v.findings).toEqual([
      { ruleId: "destructive/delete-outside-project", category: "destructive", severity: "medium", reason: "rm deletes a file in your home directory (~/veto-test-junk/fake1.txt)." },
      { ruleId: "destructive/delete-outside-project", category: "destructive", severity: "medium", reason: "rm deletes a file in your home directory (~/veto-test-junk/fake2.txt)." },
    ]);
  });
});
