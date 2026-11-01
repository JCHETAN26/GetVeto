import { describe, expect, it } from "vitest";
import { stashDrop } from "../../src/rules/destructive/stash-drop.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(stashDrop, command));

describe("destructive/stash-drop", () => {
  it("drop and clear on their own: medium", () => {
    expect(runBash(stashDrop, "git stash drop")).toEqual([
      { ruleId: "destructive/stash-drop", category: "destructive", severity: "medium", reason: "git stash drop permanently deletes a saved stash entry.", suggestion: "Leave the stash in place (`git stash list` shows it), or ask the user before deleting it." },
    ]);
    expect(s("git stash drop stash@{2}")).toBe("medium");
    expect(runBash(stashDrop, "git stash clear")[0]!.reason).toBe("git stash clear permanently deletes every saved stash.");
    expect(s("git -C ../other stash clear")).toBe("medium");
  });

  it("stash, then destroy in the same command: high", () => {
    for (const c of ["git stash && git stash drop", "git stash push -m x; git stash clear", "git stash -u && git reset --hard && git stash drop", "git stash save wip && git stash drop", "git stash; foo || git stash drop"]) {
      expect(s(c), c).toBe("high");
    }
    expect(runBash(stashDrop, "git stash && git stash drop")[0]!.reason).toBe("git stash drop runs after git stash in the same command, so it throws away the changes that were just stashed.");
  });

  it("medium when the earlier stash command didn't save anything, or may not have run", () => {
    for (const c of ["git stash list && git stash drop", "git stash pop && git stash drop", "git stash show -p && git stash drop", "git stash || git stash drop", "git stash drop && git stash"]) {
      expect(s(c), c).toBe("medium");
    }
  });

  it("other stash commands are not flagged", () => {
    for (const c of ["git stash", "git stash list", "git stash pop", "git stash apply stash@{1}", "git stash show -p", "git stash branch fix", "echo git stash drop"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("an unparsed nested script that drops a stash: medium", () => {
    expect(s(`bash -c "$X; git stash drop"`)).toBe("medium");
  });
});
