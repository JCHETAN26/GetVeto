// Guard mode through the BUILT CLI (run `npm test`, which builds first).
// Payloads are REAL captured fixtures. The redaction placeholder /REDACTED_PROJECT is replaced with
// a temp project dir; where a case needs a different command, only that value of a real payload
// is changed (shape unchanged).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, REPO, runCli, tempProject } from "../helpers.js";

const fixtures = loadFixtures().filter((f) => f.source === "real");
const pre = fixtures.filter((f) => f.event.hook_event_name === "PreToolUse");
const byName = (n: string) => fixtures.find((f) => f.name === n)!;
const expected = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "real-expected.json"), "utf8")) as Record<string, unknown>;

function project(config?: unknown): string {
  const root = tempProject();
  if (config !== undefined) {
    mkdirSync(join(root, ".veto"));
    writeFileSync(join(root, ".veto", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return root;
}
const placed = (raw: string, root: string) => raw.replaceAll("/REDACTED_PROJECT", root);
function withCommand(raw: string, root: string, command: string): string {
  const ev = JSON.parse(placed(raw, root)) as { tool_input: Record<string, unknown> };
  ev.tool_input.command = command;
  return JSON.stringify(ev);
}
async function hook(stdin: string, root: string) {
  const r = await runCli(["hook"], { cwd: root, stdin, env: { CLAUDE_PROJECT_DIR: root } });
  expect(r.code).toBe(0); // always exit 0: decisions are JSON, never exit 2
  const lines = readFileSync(join(root, ".veto", "log.jsonl"), "utf8").trim().split("\n");
  return { stdout: r.stdout, line: JSON.parse(lines.at(-1)!) as Record<string, unknown> };
}
const decision = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;

describe("veto hook in guard mode (real fixtures)", () => {
  it.each(pre.filter((f) => !(f.name in expected)).map((f) => [f.name, f] as const))("%s: benign, no output, logged as allowed", async (_n, f) => {
    const root = project({ mode: "guard" });
    const { stdout, line } = await hook(placed(f.raw, root), root);
    expect(stdout).toBe("");
    expect(line).toMatchObject({ verdict: "allow", mode: "guard", decision: "allowed" });
  });

  it("the real 19:53:36 home-folder rm (17-PreToolUse-Bash.json) -> ask (medium)", async () => {
    const root = project({ mode: "guard" });
    const { stdout, line } = await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root);
    const out = decision(stdout);
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toBe(
      "Veto: asking the user to confirm this call. " +
        "[destructive/delete-outside-project] rm deletes a file in your home directory (~/veto-test-junk/fake1.txt). " +
        "[destructive/delete-outside-project] rm deletes a file in your home directory (~/veto-test-junk/fake2.txt). " +
        "Safer: Confirm with the user before deleting files outside the project, or work inside the project.",
    );
    expect(out.additionalContext).toBe(out.permissionDecisionReason);
    expect(line).toMatchObject({ verdict: "flag", mode: "guard", decision: "asked" });
  });

  it("git reset --hard with uncommitted changes (real git status fixture, command replaced) -> deny", async () => {
    const root = project({ mode: "guard" });
    const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(root, "greet.js"), "one\n");
    git("add", "greet.js");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(root, "greet.js"), "two\n"); // uncommitted change
    const gitStatus = byName("07-PreToolUse-Bash.json");
    expect((gitStatus.event.tool_input as { command: string }).command).toBe("git status");
    const { stdout, line } = await hook(withCommand(gitStatus.raw, root, "git reset --hard HEAD~1"), root);
    const out = decision(stdout);
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toBe(
      "Veto: blocked this call. [destructive/git-discard] git reset --hard would discard uncommitted changes in this work tree. " +
        "Safer: Run `git stash` first so the changes can be restored, or ask the user before discarding them.",
    );
    expect(out).not.toHaveProperty("additionalContext");
    expect(line).toMatchObject({ mode: "guard", decision: "denied" });
  });

  it("force push to main -> deny with the push-to-a-branch alternative", async () => {
    const root = project({ mode: "guard" });
    const { stdout } = await hook(withCommand(byName("07-PreToolUse-Bash.json").raw, root, "git push --force origin main"), root);
    expect(decision(stdout).permissionDecisionReason).toMatch(/^Veto: blocked this call\. \[destructive\/force-push\] Force push to main rewrites shared history\. Safer: Push to a new branch and open a pull request/);
  });

  it("low-only findings are logged, not decided (lease push to a feature branch)", async () => {
    const root = project({ mode: "guard" });
    const { stdout, line } = await hook(withCommand(byName("07-PreToolUse-Bash.json").raw, root, "git push --force-with-lease origin feature/x"), root);
    expect(stdout).toBe("");
    expect(line).toMatchObject({ verdict: "flag", decision: "allowed" });
  });

  it("the same flagged call in watch mode (no config, or mode watch): no output", async () => {
    for (const cfg of [undefined, { mode: "watch" }]) {
      const root = project(cfg);
      const { stdout, line } = await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root);
      expect(stdout).toBe("");
      expect(line).toMatchObject({ verdict: "flag", mode: "watch", decision: "allowed" });
    }
  });

  it("disabledRules switches a rule off", async () => {
    const root = project({ mode: "guard", disabledRules: ["destructive/delete-outside-project"] });
    const { stdout, line } = await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root);
    expect(stdout).toBe("");
    expect(line).toMatchObject({ verdict: "allow", decision: "allowed" });
  });

  it("custom actions: medium -> deny", async () => {
    const root = project({ mode: "guard", actions: { medium: "deny" } });
    const { stdout } = await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root);
    expect(decision(stdout).permissionDecision).toBe("deny");
  });

  it("invalid config: behaves as watch mode, logs the error", async () => {
    for (const bad of ['{ "mode": "guard", ', { mode: "guard", actions: { high: "allow" } }]) {
      const root = project(bad);
      const { stdout, line } = await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root);
      expect(stdout).toBe("");
      expect(line).toMatchObject({ mode: "watch", decision: "allowed" });
      expect(String(line.config_error)).toContain(join(root, ".veto", "config.json"));
      expect(readFileSync(join(root, ".veto", "errors.log"), "utf8")).toMatch(/config: .*using watch mode/);
    }
  });

  it("veto log shows ⛔ for denied and ? for asked; --flagged lists both", async () => {
    const root = project({ mode: "guard" });
    const raw = byName("07-PreToolUse-Bash.json").raw;
    await hook(placed(raw, root), root); // benign
    await hook(withCommand(raw, root, "git push --force origin main"), root); // deny
    await hook(placed(byName("17-PreToolUse-Bash.json").raw, root), root); // ask
    const r = await runCli(["log"], { cwd: root });
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).not.toMatch(/[⛔?⚑] /);
    expect(lines[1]).toContain("git push --force origin main  ⛔ denied high: Force push to main rewrites shared history.");
    expect(lines[2]).toContain("? asked medium: rm deletes a file in your home directory (~/veto-test-junk/fake1.txt). (+1 more)");
    const flagged = await runCli(["log", "--flagged"], { cwd: root });
    expect(flagged.stdout.trim().split("\n")).toHaveLength(3); // 2 + footer
  });

  it("never prints permissionDecision allow, for any real fixture, in either mode", async () => {
    for (const mode of ["guard", "watch"]) {
      const root = project({ mode });
      for (const f of fixtures) {
        const { stdout } = await hook(placed(f.raw, root), root);
        expect(stdout).not.toContain('"allow"');
      }
    }
  });
});
