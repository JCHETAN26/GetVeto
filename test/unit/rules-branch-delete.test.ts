import { describe, expect, it } from "vitest";
import { branchDelete } from "../../src/rules/destructive/branch-delete.js";
import { runBash, sev } from "../rule-helpers.js";

const f = (command: string) => runBash(branchDelete, command);
const s = (command: string) => sev(f(command));

describe("destructive/branch-delete", () => {
  it("remote delete of main/master: high", () => {
    for (const c of ["git push --delete origin main", "git push origin --delete master", "git push -d origin main", "git push origin :main", "git push origin :refs/heads/main", "git push origin +:master", "git push --delete origin feature/x main"]) {
      expect(s(c), c).toBe("high");
    }
    expect(f("git push origin --delete main")).toEqual([
      { ruleId: "destructive/branch-delete", category: "destructive", severity: "high", reason: "git push --delete on origin deletes main, the main branch, on the remote.", suggestion: "Ask the user before deleting a branch on the remote." },
    ]);
  });

  it("remote delete of other branches: medium", () => {
    expect(f("git push origin --delete feature/x")[0]).toMatchObject({ severity: "medium", reason: "git push --delete on origin deletes the remote branch feature/x." });
    expect(s("git push origin :old-branch")).toBe("medium");
    expect(s("git push --delete origin $BRANCH")).toBe("medium");
  });

  it("local git branch -D: high for main/master, low otherwise", () => {
    expect(f("git branch -D main")[0]).toMatchObject({ severity: "high", reason: "git branch -D deletes main, the main branch, even with unmerged commits." });
    expect(s("git branch --delete --force master")).toBe("high");
    expect(s("git branch -df master")).toBe("high");
    expect(f("git branch -D feature/x")[0]).toMatchObject({ severity: "low", reason: "git branch -D deletes the local branch feature/x even with unmerged commits." });
    expect(s("git branch -D $B")).toBe("medium"); // unresolved: could be main
    expect(s("git branch -D -r origin/main")).toBe("low"); // remote-tracking ref only
  });

  it("not flagged: safe deletes, pushes, and listing", () => {
    for (const c of ["git branch -d feature/x", "git branch -d main", "git branch", "git branch -a", "git branch -m old new", "git push origin main", "git push origin :", "git push -u origin feature/x", "git push origin feature/x:feature/x", "git push origin HEAD:main"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("an unparsed nested script that deletes a branch: medium", () => {
    expect(s(`bash -c "$X; git push origin --delete main"`)).toBe("medium");
  });
});
