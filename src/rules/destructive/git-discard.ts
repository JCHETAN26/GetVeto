// git commands that throw away uncommitted work: reset --hard, checkout -- <paths> / . / -f,
// restore (of the work tree), clean -d / -x. Medium; high when `git status` shows there is
// work to lose. The git check only runs when one of these commands is present.
//
// Low when a full `git stash` in the same work tree has certainly run first in the same
// command (`git stash && git reset --hard`, see ranBefore in shell/parse.ts): the work is
// saved, not lost. `git status` runs before the whole command, so without this the advice
// "run git stash first" could never be followed. A plain stash doesn't save untracked
// files, so it only covers git clean with -u (clean -d) or -a (clean -x). A `git stash pop`
// in between, or a stash drop/clear anywhere in the command, cancels it.
import { hasLong, hasShort, splitArgs, unparsedNestedMatching } from "../args.js";
import { gitCall, isStashDelete, stashSaves, type GitCall, type StashSave } from "../git.js";
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import type { Finding, GitStatus, Rule, RuleContext } from "../types.js";

const ID = "destructive/git-discard";

const STASH = "Run `git stash` first so the changes can be restored, or ask the user before discarding them.";
const CLEAN = "Run `git clean -n` with the same flags first to list what would be deleted, and confirm with the user.";

const STASH_U = "Use `git stash -u` (or `-a` with -x) so untracked files are saved too, or run `git clean -n` first and confirm with the user.";

interface Discard {
  what: string;
  loses: keyof GitStatus;
  /** git clean -x: ignored files too. */
  ignored?: boolean;
}

/** Which kind of work the command throws away, or null if it doesn't. */
function discards(sub: string, args: Arg[]): Discard | null {
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
      return d || x ? { what: `git clean -${d ? "d" : ""}${x ? "x" : ""}`, loses: "untracked", ignored: x } : null;
    }
    default:
      return null;
  }
}

const NESTED = /\bgit\b[^;&|]*\b(reset\b[^;&|]*--hard|checkout\b[^;&|]*(\s-f\b|--force|\s--(\s|$)|\s\.(\s|$|["'\\]))|restore\b|clean\b[^;&|]*\s-[a-zA-Z]*[dx])/;

/** The full stash that certainly ran before `c` in the same work tree, if any. */
function stashedBefore(c: SimpleCommand, g: GitCall, ctx: RuleContext): StashSave | null {
  if (g.dir === null) return null;
  const sameTree = (i: number) => {
    const s = gitCall(ctx.commands[i]!, ctx);
    return s && s.sub === "stash" && s.dir === g.dir ? s : null;
  };
  let best: StashSave | null = null;
  for (const j of c.ranBefore) {
    const s = sameTree(j);
    const saves = s && stashSaves(s.args);
    if (!saves) continue;
    // `git stash && git stash pop && git reset --hard`: the changes are back in the work tree.
    const popped = c.ranBefore.some((k) => k > j && sameTree(k)?.args[0]?.value === "pop");
    if (popped) continue;
    if (!best || (saves.untracked && !best.untracked) || (saves.ignored && !best.ignored)) best = saves;
  }
  return best;
}

const covers = (s: StashSave, d: Discard) => (d.loses === "tracked" ? true : d.ignored ? s.ignored : s.untracked);

export const gitDiscard: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["git"],
  check(ctx) {
    const out: Finding[] = [];
    // A drop/clear anywhere means the stash may not survive the command (stash-drop flags it).
    const dropped = ctx.commands.some((c) => {
      const g = gitCall(c, ctx);
      return g !== null && isStashDelete(g);
    });
    for (const c of ctx.commands) {
      const g = gitCall(c, ctx);
      if (!g) continue;
      const d = discards(g.sub, g.args);
      if (!d) continue;
      const label = d.loses === "untracked" ? "untracked files" : "uncommitted changes";
      const stash = dropped ? null : stashedBefore(c, g, ctx);
      if (stash && covers(stash, d)) {
        out.push({ ruleId: ID, category: "destructive", severity: "low", reason: `${d.what} runs after git stash in the same command, so the ${label} are stashed first (git stash pop restores them).` });
        continue;
      }
      // A stash ran, but without -u/-a it left the untracked files for git clean to delete.
      const partial = stash ? ` git stash ran first, but without ${d.ignored ? "-a" : "-u"} it doesn't save them.` : "";
      const status = g.dir === null ? null : ctx.gitStatus(g.dir);
      const suggestion = stash ? STASH_U : d.loses === "untracked" ? CLEAN : STASH;
      if (status?.[d.loses]) {
        out.push({ ruleId: ID, category: "destructive", severity: "high", reason: `${d.what} would discard ${label} in this work tree.${partial}`, suggestion });
      } else {
        const why = status === null ? `; couldn't check for ${label}` : "";
        out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `${d.what} discards ${label}${why}.${partial}`, suggestion });
      }
    }
    for (const c of unparsedNestedMatching(ctx, NESTED)) {
      out.push({ ruleId: ID, category: "destructive", severity: "medium", reason: `A nested script that couldn't be parsed looks like it discards git work (${c.nestedReason ?? "unparsed"}).`, suggestion: STASH });
    }
    return out;
  },
};
