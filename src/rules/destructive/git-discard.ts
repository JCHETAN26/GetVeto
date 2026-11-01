// git commands that throw away uncommitted work: reset --hard, checkout -- <paths> / . / -f,
// restore (of the work tree), clean -d / -x. Medium; high when `git status` shows there is
// work to lose. The git check only runs when one of these commands is present.
import { hasLong, hasShort, splitArgs, unparsedNestedMatching } from "../args.js";
import { gitCall } from "../git.js";
import type { Arg } from "../../shell/parse.js";
import type { Finding, GitStatus, Rule } from "../types.js";

const ID = "destructive/git-discard";

/** Which kind of work the command throws away, or null if it doesn't. */
function discards(sub: string, args: Arg[]): { what: string; loses: keyof GitStatus } | null {
  const { options, operands } = splitArgs(args);
  const dashdash = args.some((a) => a.value === "--" && !a.unresolved);
  switch (sub) {
    case "reset":
      return hasLong(options, "--hard") ? { what: "git reset --hard", loses: "tracked" } : null;
    case "checkout":
      if (hasShort(options, "f") || hasLong(options, "--force")) return { what: "git checkout --force", loses: "tracked" };
      if (dashdash && operands.length > 0) return { what: "git checkout -- <paths>", loses: "tracked" };
      if (operands.some((a) => a.value === "." && !a.unresolved)) return { what: "git checkout .", loses: "tracked" };
      return null;
    case "restore": {
      const staged = hasShort(options, "S") || hasLong(options, "--staged");
      const worktree = hasShort(options, "W") || hasLong(options, "--worktree");
      return !staged || worktree ? { what: "git restore", loses: "tracked" } : null;
    }
    case "clean": {
      if (hasShort(options, "n") || hasLong(options, "--dry-run")) return null;
      const d = hasShort(options, "d");
      const x = hasShort(options, "x");
      return d || x ? { what: `git clean -${d ? "d" : ""}${x ? "x" : ""}`, loses: "untracked" } : null;
    }
    default:
      return null;
  }
}

const NESTED = /\bgit\b[^;&|]*\b(reset\b[^;&|]*--hard|checkout\b[^;&|]*(\s-f\b|--force|\s--(\s|$)|\s\.(\s|$|["'\\]))|restore\b|clean\b[^;&|]*\s-[a-zA-Z]*[dx])/;

export const gitDiscard: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["git"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      const g = gitCall(c, ctx);
      if (!g) continue;
      const d = discards(g.sub, g.args);
      if (!d) continue;
      const status = g.dir === null ? null : ctx.gitStatus(g.dir);
      const label = d.loses === "untracked" ? "untracked files" : "uncommitted changes";
      if (status?.[d.loses]) {
        out.push({ ruleId: ID, category: "destructive", severity: "high", reason: `${d.what} would discard ${label} in this work tree.` });
      } else {
        const why = status === null ? `; couldn't check for ${label}` : "";
        out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `${d.what} discards ${label}${why}.` });
      }
    }
    for (const c of unparsedNestedMatching(ctx, NESTED)) {
      out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `A nested script that couldn't be parsed looks like it discards git work (${c.nestedReason ?? "unparsed"}).` });
    }
    return out;
  },
};
