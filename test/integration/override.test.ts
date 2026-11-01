// Overrides through the BUILT CLI: `veto allow --once`, `veto allow <ruleId>`, `veto deny <ruleId>`,
// and the hook's handling of them in guard mode. Hook payloads are REAL captured fixtures
// (cwd/command values changed where noted; shape unchanged).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowOnce } from "../../src/override-cli.js";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const fixtures = loadFixtures().filter((f) => f.source === "real");
const byName = (n: string) => fixtures.find((f) => f.name === n)!;
/** Real event 19: `git diff > $S/... && git reset --hard HEAD~1`, denied in a dirty repo. */
const RESET = "19-PreToolUse-Bash.json";
const at = (name: string, root: string, command?: string) => {
  const ev = { ...byName(name).event, cwd: root } as Record<string, unknown>;
  if (command !== undefined) ev.tool_input = { ...(ev.tool_input as object), command };
  return JSON.stringify(ev);
};

/** A guard-mode project that is a git repo with an uncommitted change. */
function project(): string {
  const root = tempProject("veto-override-");
  mkdirSync(join(root, ".veto"));
  writeFileSync(join(root, ".veto", "config.json"), JSON.stringify({ mode: "guard" }));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(root, "a.txt"), "two\n");
  return root;
}
const logLines = (root: string) => readFileSync(join(root, ".veto", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
async function hook(stdin: string, root: string) {
  const r = await runCli(["hook"], { cwd: root, stdin, env: { CLAUDE_PROJECT_DIR: root } });
  expect(r.code).toBe(0);
  return { stdout: r.stdout, line: logLines(root).at(-1)! };
}
const decisionOf = (stdout: string) => (stdout === "" ? "none" : (JSON.parse(stdout).hookSpecificOutput.permissionDecision as string));
const overrideFile = (root: string) => join(root, ".veto", "override.json");

describe("veto allow --once", () => {
  it("allows the next matching call once, logs it, then expires by use", async () => {
    const root = project();
    expect(decisionOf((await hook(at(RESET, root), root)).stdout)).toBe("deny");
    expect(logLines(root).at(-1)!.because).toEqual([{ ruleId: "destructive/git-discard", reason: "git reset --hard would discard uncommitted changes in this work tree." }]);

    const a = await runCli(["allow", "--once"], { cwd: root });
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("Allowed once, in " + root + " only, until ");
    expect(a.stdout).toContain("[destructive/git-discard] git reset --hard would discard uncommitted changes in this work tree.");
    expect(statSync(overrideFile(root)).mode & 0o777).toBe(0o600);
    expect(logLines(root).at(-1)!.veto).toMatchObject({ action: "allow-once", findings: [{ ruleId: "destructive/git-discard" }] });

    // The retry (same finding, slightly different command): no decision, override recorded and used up.
    expect((await runCli(["status"], { cwd: root })).stdout).toMatch(/override: allow --once pending \(destructive\/git-discard; expires /);
    const retry = await hook(at(RESET, root, "git reset --hard HEAD~1 && git log --oneline -1"), root);
    expect(retry.stdout).toBe("");
    expect(retry.line).toMatchObject({ verdict: "flag", decision: "allowed", override: { kind: "once", findings: [{ ruleId: "destructive/git-discard" }] } });
    expect(existsSync(overrideFile(root))).toBe(false);

    // Used up: the same call is denied again.
    expect(decisionOf((await hook(at(RESET, root), root)).stdout)).toBe("deny");

    const log = await runCli(["log"], { cwd: root });
    expect(log.stdout).toMatch(/you {3}veto {8}allow --once \(destructive\/git-discard\) for the call denied at/);
    expect(log.stdout).toContain("✓ allowed once by you, high: git reset --hard would discard");
  });

  it("does not cover a call with a different finding, and is not used up by it", async () => {
    const root = project();
    await hook(at(RESET, root), root);
    expect((await runCli(["allow", "--once"], { cwd: root })).code).toBe(0);
    const other = await hook(at(RESET, root, "git push --force origin main"), root);
    expect(decisionOf(other.stdout)).toBe("deny");
    expect(other.line).not.toHaveProperty("override");
    expect(existsSync(overrideFile(root))).toBe(true);
    // a call that has the covered finding AND a new blocking one is still denied
    const both = await hook(at(RESET, root, "git reset --hard && git push --force origin main"), root);
    expect(decisionOf(both.stdout)).toBe("deny");
    expect(existsSync(overrideFile(root))).toBe(true);
  });

  it("expires after 10 minutes", async () => {
    const root = project();
    await hook(at(RESET, root), root);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    expect(allowOnce(root, () => {}, () => {}, elevenMinutesAgo)).toBe(0);
    expect(decisionOf((await hook(at(RESET, root), root)).stdout)).toBe("deny");
  });

  it("applies only in the project it was made in", async () => {
    const a = project();
    const b = project();
    await hook(at(RESET, a), a);
    await hook(at(RESET, b), b);
    expect((await runCli(["allow", "--once"], { cwd: a })).code).toBe(0);
    writeFileSync(overrideFile(b), readFileSync(overrideFile(a))); // even a copied file
    expect(decisionOf((await hook(at(RESET, b), b)).stdout)).toBe("deny");
    expect(decisionOf((await hook(at(RESET, a), a)).stdout)).toBe("none");
  });

  it("works from a subfolder; fails clearly with nothing denied or no project", async () => {
    const root = project();
    mkdirSync(join(root, "src"));
    const none = await runCli(["allow", "--once"], { cwd: join(root, "src") });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain(`nothing to allow: no denied call in ${join(root, ".veto", "log.jsonl")}`);
    await hook(at(RESET, root), root);
    expect((await runCli(["allow", "--once"], { cwd: join(root, "src") })).code).toBe(0);
    const nowhere = await runCli(["allow", "--once"], { cwd: tempProject("veto-none-") });
    expect(nowhere.code).toBe(1);
    expect(nowhere.stderr).toMatch(/no Veto project here/);
  });

  it("the agent running veto allow --once through Bash is denied, and gets no override", async () => {
    const root = project();
    await hook(at(RESET, root), root);
    const r = await hook(at(RESET, root, "veto allow --once"), root);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("[self-protection/override] veto allow run by the agent would override Veto; the user must run it in their own terminal.");
    expect(existsSync(overrideFile(root))).toBe(false);
  });
});

describe("veto allow <ruleId> / veto deny <ruleId>", () => {
  it("disables and re-enables a rule in .veto/config.json, logged", async () => {
    const root = project();
    const a = await runCli(["allow", "destructive/git-discard"], { cwd: root });
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("destructive/git-discard is disabled in this project");
    expect(JSON.parse(readFileSync(join(root, ".veto", "config.json"), "utf8"))).toMatchObject({ mode: "guard", disabledRules: ["destructive/git-discard"] });
    expect(logLines(root).at(-1)!.veto).toEqual({ action: "allow-rule", ruleId: "destructive/git-discard" });
    const r = await hook(at(RESET, root), root);
    expect(r.stdout).toBe("");
    expect(r.line.verdict).toBe("allow");

    expect((await runCli(["allow", "destructive/git-discard"], { cwd: root })).stdout).toContain("already disabled");
    const d = await runCli(["deny", "destructive/git-discard"], { cwd: root });
    expect(d.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".veto", "config.json"), "utf8")).disabledRules).toEqual([]);
    expect(logLines(root).at(-1)!.veto).toEqual({ action: "deny-rule", ruleId: "destructive/git-discard" });
    expect(decisionOf((await hook(at(RESET, root), root)).stdout)).toBe("deny");
  });

  it("rejects unknown rule ids and bad usage", async () => {
    const root = project();
    const u = await runCli(["allow", "destructive/nope"], { cwd: root });
    expect(u.code).toBe(1);
    expect(u.stderr).toMatch(/unknown rule id: destructive\/nope\nRule ids: .*destructive\/git-discard/);
    expect((await runCli(["deny"], { cwd: root })).code).toBe(1);
    expect((await runCli(["allow", "--forever"], { cwd: root })).code).toBe(1);
  });
});
