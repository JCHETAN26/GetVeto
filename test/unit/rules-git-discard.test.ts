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

  describe("a full git stash earlier in the same command", () => {
    const dirty = () => ({ gitStatus: () => ({ tracked: true, untracked: true }) });
    const f = (command: string) => runBash(gitDiscard, command, dirty());

    it("git stash && / ; git reset --hard: low, says the changes are stashed first", () => {
      for (const c of ["git stash && git reset --hard HEAD~1", "git stash; git reset --hard", "git stash push -m wip && git reset --hard", "git stash save wip && git reset --hard", "git stash -q && git checkout -- .", "git stash push --keep-index && git restore ."]) {
        expect(sev(f(c)), c).toBe("low");
      }
      expect(f("git stash && git reset --hard")[0]).toEqual({
        ruleId: "destructive/git-discard",
        category: "destructive",
        severity: "low",
        reason: "git reset --hard runs after git stash in the same command, so the uncommitted changes are stashed first (git stash pop restores them).",
      });
    });

    it("not when the stash may not have run or saved everything", () => {
      for (const c of [
        "git stash || git reset --hard", // reset runs only if the stash failed
        "git reset --hard && git stash", // stash comes after
        "git stash | cat && git reset --hard",
        "! git stash && git reset --hard",
        "x || git stash && git reset --hard", // the stash may be skipped
        "git stash -p && git reset --hard", // partial
        "git stash push src/ && git reset --hard", // pathspec: partial
        "git stash push -- src/ && git reset --hard",
        "git stash --staged && git reset --hard",
        "git stash list && git reset --hard",
        "git stash && git stash pop && git reset --hard", // the changes are back
        "git stash && git reset --hard && git stash drop", // stash then destroy
        "git stash && cd ../other && git reset --hard", // a different work tree
        "git -C ../other stash && git reset --hard",
      ]) {
        expect(sev(f(c)), c).toBe("high");
      }
      // unknown directory: no git check (medium), and no downgrade either
      expect(sev(f("cd $D && git stash && git reset --hard"))).toBe("medium");
    });

    it("pop after the reset is fine (moving changes onto an earlier commit)", () => {
      expect(sev(f("git stash && git reset --hard HEAD~1 && git stash pop"))).toBe("low");
    });

    it("git clean: a plain stash doesn't save untracked files; -u does, and -x needs -a", () => {
      expect(sev(f("git stash && git clean -fd"))).toBe("high");
      expect(f("git stash && git clean -fd")[0]!.reason).toBe("git clean -d would discard untracked files in this work tree. git stash ran first, but without -u it doesn't save them.");
      expect(f("git stash && git clean -fd")[0]!.suggestion).toMatch(/git stash -u/);
      expect(sev(f("git stash -u && git clean -fd"))).toBe("low");
      expect(sev(f("git stash --include-untracked && git clean -fd"))).toBe("low");
      expect(sev(f("git stash -u && git clean -fdx"))).toBe("high");
      expect(sev(f("git stash --all && git clean -fdx"))).toBe("low");
      expect(sev(f("git stash -u && git reset --hard && git clean -fd"))).toBe("low");
    });

    it("with real git: a dirty repo is high without the stash, low with it", () => {
      const d = repo("dirty");
      const opts = { cwd: d, root: d, gitStatus: readGitStatus };
      expect(sev(runBash(gitDiscard, "git reset --hard", opts))).toBe("high");
      expect(sev(runBash(gitDiscard, "git stash && git reset --hard", opts))).toBe("low");
    });
  });
});
