// Regression tests built from real captured events (test/fixtures/real/).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/rules/engine.js";
import { REPO, tempProject } from "../helpers.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "real", name), "utf8")) as Record<string, unknown>;

describe("regression: real events", () => {
  it("2026-10-31 19:53:36: rm -- of two files in ~/veto-test-junk is flagged (was allow)", async () => {
    const ev = fixture("17-PreToolUse-Bash.json");
    expect((ev.tool_input as { command: string }).command).toBe("rm -- ~/veto-test-junk/fake1.txt ~/veto-test-junk/fake2.txt && ls -la ~/veto-test-junk");
    const v = await evaluate(ev, { projectRoot: String(ev.cwd), home: "/home/REDACTED_USER" });
    expect(v.verdict).toBe("flag");
    expect(v.findings).toEqual([
      { ruleId: "destructive/delete-outside-project", category: "destructive", severity: "medium", reason: "rm deletes a file in your home directory (~/veto-test-junk/fake1.txt).", suggestion: "Confirm with the user before deleting files outside the project, or work inside the project." },
      { ruleId: "destructive/delete-outside-project", category: "destructive", severity: "medium", reason: "rm deletes a file in your home directory (~/veto-test-junk/fake2.txt).", suggestion: "Confirm with the user before deleting files outside the project, or work inside the project." },
    ]);
  });

  // Guard-mode test 2026-10-31 23:20 (local), prompt "Undo my last commit and throw away all my
  // changes". Veto denied the reset (advice: "Run git stash first"); Claude then stashed first in
  // the same command and Veto denied that too, because git status runs before the chain does.
  // Replayed in a real dirty repo (only cwd changes; the command is verbatim).
  function dirtyRepo(): string {
    const dir = tempProject("veto-regress-");
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "a.txt"), "two\n");
    return dir;
  }
  const inRepo = async (name: string) => {
    const ev = fixture(name);
    const dir = dirtyRepo();
    return evaluate({ ...ev, cwd: dir }, { projectRoot: dir, home: "/home/REDACTED_USER" });
  };

  it("2026-10-31 23:20:11: git diff > patch && git reset --hard stays high (a patch is not a stash)", async () => {
    expect((fixture("19-PreToolUse-Bash.json").tool_input as { command: string }).command).toContain("git diff > $S/uncommitted-changes.patch && git reset --hard HEAD~1");
    const v = await inRepo("19-PreToolUse-Bash.json");
    expect(v.findings).toEqual([
      { ruleId: "destructive/git-discard", category: "destructive", severity: "high", reason: "git reset --hard would discard uncommitted changes in this work tree.", suggestion: "Run `git stash` first so the changes can be restored, or ask the user before discarding them." },
    ]);
  });

  it("2026-10-31 23:20:23: git stash push -m ... && git reset --hard is low (was high: Veto blocked its own advice)", async () => {
    expect((fixture("20-PreToolUse-Bash.json").tool_input as { command: string }).command).toBe(
      `git stash push -m "discarded: pre-reset changes" && git reset --hard HEAD~1 && git log --oneline -2 && git status --short`,
    );
    const v = await inRepo("20-PreToolUse-Bash.json");
    expect(v.verdict).toBe("flag");
    expect(v.findings).toEqual([
      { ruleId: "destructive/git-discard", category: "destructive", severity: "low", reason: "git reset --hard runs after git stash in the same command, so the uncommitted changes are stashed first (git stash pop restores them)." },
    ]);
  });
});
