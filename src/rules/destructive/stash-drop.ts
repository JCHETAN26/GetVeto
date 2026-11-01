// git stash drop / git stash clear: permanently delete saved work (a dropped stash can only be
// dug out of git's unreachable objects). Medium; high when a `git stash` has certainly run
// first in the same command ("stash, then destroy": the changes it saved are thrown away).
import { unparsedNestedMatching } from "../args.js";
import { gitCall, isStashDelete } from "../git.js";
import type { Finding, Rule } from "../types.js";

const ID = "destructive/stash-drop";
const TIP = "Leave the stash in place (`git stash list` shows it), or ask the user before deleting it.";

export const stashDrop: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["git"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      const g = gitCall(c, ctx);
      if (!g || !isStashDelete(g)) continue;
      const what = `git stash ${g.args[0]!.value}`;
      // A stash that saved something: plain `git stash`, `git stash push|save` (even partial).
      const stashedFirst = c.ranBefore.some((j) => {
        const s = gitCall(ctx.commands[j]!, ctx);
        if (!s || s.sub !== "stash" || (s.dir !== null && g.dir !== null && s.dir !== g.dir)) return false;
        const first = s.args[0];
        return !first || (!first.unresolved && (first.value.startsWith("-") || first.value === "push" || first.value === "save"));
      });
      if (stashedFirst) {
        out.push({ ruleId: ID, category: "destructive", severity: "high", reason: `${what} runs after git stash in the same command, so it throws away the changes that were just stashed.`, suggestion: TIP });
      } else {
        const target = what === "git stash clear" ? "every saved stash" : "a saved stash entry";
        out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `${what} permanently deletes ${target}.`, suggestion: TIP });
      }
    }
    for (const c of unparsedNestedMatching(ctx, /\bgit\b[^;&|]*\bstash\s+(drop|clear)\b/)) {
      out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `A nested script that couldn't be parsed looks like it deletes a git stash (${c.nestedReason ?? "unparsed"}).`, suggestion: TIP });
    }
    return out;
  },
};
