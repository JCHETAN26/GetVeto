// Deleting branches. Remote: `git push --delete|-d <remote> <branch>...` and the empty-source
// refspec `git push <remote> :<branch>`. Local: `git branch -D` (or --delete --force), which
// deletes even unmerged commits. main/master: high either way. Other branches: medium on the
// remote (it goes for everyone), low locally (the reflog still has the commits for a while).
// Plain `git branch -d` refuses to delete unmerged work and is not flagged.
import type { Arg } from "../../shell/parse.js";
import { hasLong, hasShort, splitArgs, unparsedNestedMatching } from "../args.js";
import { gitCall, pushArgs } from "../git.js";
import { lower, type Finding, type Rule, type Severity } from "../types.js";

const ID = "destructive/branch-delete";
const PROTECTED = new Set(["main", "master"]);
const TIP = {
  remote: "Ask the user before deleting a branch on the remote.",
  local: "Use `git branch -d`, which refuses to delete unmerged work, or ask the user.",
};
const finding = (severity: Severity, reason: string, suggestion: string): Finding => ({ ruleId: ID, category: "destructive", severity, reason, suggestion });
const name = (ref: string) => ref.replace(/^\+/, "").replace(/^:/, "").replace(/^refs\/heads\//, "");

/** One finding for the branches a command deletes. */
function judge(branches: Arg[], where: "remote" | "local", what: string): Finding {
  const unresolved = branches.filter((b) => b.unresolved);
  const names = branches.filter((b) => !b.unresolved).map((b) => name(b.value));
  const prot = names.find((n) => PROTECTED.has(n));
  const tip = TIP[where];
  if (prot) return finding("high", `${what} deletes ${prot}, the main branch${where === "remote" ? ", on the remote" : ", even with unmerged commits"}.`, tip);
  const base: Severity = where === "remote" ? "medium" : "low";
  if (unresolved.length) return finding(where === "remote" ? "medium" : lower("high"), `${what} deletes ${unresolved.map((b) => b.raw).join(" ")}; the branch couldn't be resolved.`, tip);
  return finding(base, `${what} deletes the ${where === "remote" ? "remote" : "local"} branch ${names.join(", ")}${where === "local" ? " even with unmerged commits" : ""}.`, tip);
}

export const branchDelete: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["git"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      const g = gitCall(c, ctx);
      if (!g) continue;
      if (g.sub === "push") {
        const { options, operands } = pushArgs(g.args);
        const refspecs = operands.slice(1);
        const remote = operands[0]?.raw ?? "the remote";
        if (hasLong(options, "--delete") || hasShort(options, "d")) {
          if (refspecs.length) out.push(judge(refspecs, "remote", `git push --delete on ${remote}`));
          continue;
        }
        // `:branch` (empty source) deletes it; a lone ":" means "push matching branches".
        const deleted = refspecs.filter((r) => !r.unresolved && /^\+?:./.test(r.value));
        if (deleted.length) out.push(judge(deleted, "remote", `git push ${remote} :<branch>`));
        continue;
      }
      if (g.sub === "branch") {
        const { options, operands } = splitArgs(g.args);
        const del = hasShort(options, "D") || ((hasShort(options, "d") || hasLong(options, "--delete")) && (hasShort(options, "f") || hasLong(options, "--force")));
        if (!del || operands.length === 0) continue;
        // -r: only the remote-tracking ref goes (origin/x); the remote and local branch stay.
        if (hasShort(options, "r") || hasLong(options, "--remotes")) {
          out.push(finding("low", `git branch -D -r deletes the remote-tracking ref ${operands.map((o) => o.raw).join(", ")} (the branch on the remote stays).`, TIP.local));
          continue;
        }
        out.push(judge(operands, "local", "git branch -D"));
      }
    }
    for (const c of unparsedNestedMatching(ctx, /\bgit\b[^;&|]*\b(push\b[^;&|]*(--delete|\s-d\b|\s\+?:\S)|branch\b[^;&|]*\s-[a-zA-Z]*D)/)) {
      out.push(finding("medium", `A nested script that couldn't be parsed looks like it deletes a git branch (${c.nestedReason ?? "unparsed"}).`, TIP.remote));
    }
    return out;
  },
};
