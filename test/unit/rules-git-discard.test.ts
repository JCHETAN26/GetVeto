import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiscard } from "../../src/rules/destructive/git-discard.js";
import { readGitStatus } from "../../src/rules/engine.js";
import { tempProject } from "../helpers.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(gitDiscard, command));

/** A real git repo with one commit; dirty = an edited tracked file, untracked = a new file. */
function repo(state: "clean" | "dirty" | "untracked"): string {
  const dir = tempProject("veto-git-");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  if (state === "dirty") writeFileSync(join(dir, "a.txt"), "two\n");
  if (state === "untracked") writeFileSync(join(dir, "new.txt"), "x\n");
  return dir;
}

describe("destructive/git-discard", () => {
  it("near-miss: reset --soft (fine) vs reset --hard (flagged)", () => {
    expect(s("git reset --soft HEAD~1")).toBeNull();
    expect(s("git reset HEAD~1")).toBeNull();
    expect(s("git reset --hard HEAD~1")).toBe("medium");
  });

  it("checkout: -- <paths>, ., -f are flagged; switching branches is not", () => {
    expect(s("git checkout -- src/index.js")).toBe("medium");
    expect(s("git checkout .")).toBe("medium");
    expect(s("git checkout -f main")).toBe("medium");
    expect(s("git checkout --force main")).toBe("medium");
    expect(s("git checkout main")).toBeNull();
    expect(s("git checkout -b feature/x")).toBeNull();
  });

  it("restore: work tree flagged, --staged only is not", () => {
    expect(s("git restore src/index.js")).toBe("medium");
    expect(s("git restore .")).toBe("medium");
    expect(s("git restore --staged src/index.js")).toBeNull();
    expect(s("git restore -S .")).toBeNull();
    expect(s("git restore --staged --worktree .")).toBe("medium");
  });

  it("clean: -d / -x flagged; -n dry run and plain -f are not", () => {
    expect(s("git clean -fd")).toBe("medium");
    expect(s("git clean -fdx")).toBe("medium");
    expect(s("git clean -xf")).toBe("medium");
    expect(s("git clean -nd")).toBeNull();
    expect(s("git clean -f")).toBeNull();
  });

  it("everyday git commands are not flagged", () => {
    for (const c of ["git status", "git log --oneline -5", "git diff", "git add -A && git commit -m wip", "git stash", "git pull --rebase", "git branch -d old"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("follows git global options to the subcommand", () => {
    expect(s("git -C ../other reset --hard")).toBe("medium");
    expect(s("git -c core.pager=cat reset --hard")).toBe("medium");
    expect(s("git --no-pager log")).toBeNull();
  });

  it("high when real `git status` shows work to lose; medium when clean or unknown", () => {
    const opts = (dir: string) => ({ cwd: dir, root: dir, gitStatus: readGitStatus });
    expect(sev(runBash(gitDiscard, "git reset --hard", opts(repo("dirty"))))).toBe("high");
    expect(sev(runBash(gitDiscard, "git reset --hard", opts(repo("clean"))))).toBe("medium");
    // untracked files: what git clean loses, but not reset --hard
    const u = repo("untracked");
    expect(sev(runBash(gitDiscard, "git clean -fd", opts(u)))).toBe("high");
    expect(sev(runBash(gitDiscard, "git reset --hard", opts(u)))).toBe("medium");
    // the check runs in the effective cwd
    const d = repo("dirty");
    expect(sev(runBash(gitDiscard, `cd ${d} && git checkout .`, { cwd: "/", root: d, gitStatus: readGitStatus }))).toBe("high");
    expect(sev(runBash(gitDiscard, `git -C ${d} restore .`, { cwd: "/", root: d, gitStatus: readGitStatus }))).toBe("high");
    // not a repo: the check fails, stays medium and says so
    const notRepo = tempProject("veto-norepo-");
    const f = runBash(gitDiscard, "git reset --hard", opts(notRepo));
    expect(f[0]).toMatchObject({ severity: "medium" });
    expect(f[0]!.reason).toMatch(/couldn't check/);
  });

  it("only calls git status when a discarding command is present", () => {
    const seen: string[] = [];
    const spy = (dir: string) => (seen.push(dir), null);
    runBash(gitDiscard, "git status && npm test", { gitStatus: spy });
    expect(seen).toEqual([]);
    runBash(gitDiscard, "cd src && git checkout -- index.js", { gitStatus: spy });
    expect(seen).toEqual(["/home/alice/code/app/src"]);
  });

  it("an unknown cwd skips the check (medium)", () => {
    const f = runBash(gitDiscard, "cd $DIR && git reset --hard", { gitStatus: () => ({ tracked: true, untracked: true }) });
    expect(sev(f)).toBe("medium");
  });

  it("flags an unparsed nested script that mentions reset --hard", () => {
    expect(s(`bash -c "sh -c 'dash -c \\"zsh -c \\\\\\"git reset --hard\\\\\\"\\"'"`)).toBe("medium");
    expect(s("bash -c 'git reset --hard'")).toBe("medium"); // parsed: the inner command matches
  });
});
