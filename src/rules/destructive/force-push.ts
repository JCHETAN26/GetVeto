// git push that can overwrite remote history: --force / -f / +refspec, --force-with-lease,
// --mirror. High for main/master or when no branch is named; lease to another branch is low.
import type { Arg } from "../../shell/parse.js";
import { unparsedNestedMatching } from "../args.js";
import { gitCall } from "../git.js";
import { lower, type Finding, type Rule, type Severity } from "../types.js";

const ID = "destructive/force-push";
const PROTECTED = new Set(["main", "master"]);
/** push options that take a separate value word. */
const VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

const finding = (severity: Severity, reason: string): Finding => ({ ruleId: ID, category: "destructive", severity, reason });

function branchOf(refspec: string): string {
  const dst = refspec.replace(/^\+/, "").split(":").pop() ?? "";
  return dst.replace(/^refs\/heads\//, "");
}

export const forcePush: Rule = {
  id: ID,
  category: "destructive",
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      const g = gitCall(c, ctx);
      if (!g || g.sub !== "push") continue;
      const options: string[] = [];
      const operands: Arg[] = [];
      let end = false;
      for (let i = 0; i < g.args.length; i++) {
        const a = g.args[i]!;
        if (!end && a.value === "--" && !a.unresolved) end = true;
        else if (!end && !a.unresolved && a.value.startsWith("-") && a.value.length > 1) {
          options.push(a.value);
          if (VALUE_OPTS.has(a.value)) i++;
        } else operands.push(a);
      }
      const has = (name: string) => options.some((o) => o === name || o.startsWith(name + "="));
      const shortF = options.some((o) => /^-[^-]/.test(o) && o.includes("f"));
      const refspecs = operands.slice(1);
      const plusRef = refspecs.some((r) => !r.unresolved && r.value.startsWith("+"));
      const plain = shortF || has("--force") || plusRef;
      const lease = has("--force-with-lease");

      if (has("--mirror")) {
        out.push(finding("high", "git push --mirror overwrites every ref on the remote."));
        continue;
      }
      if (!plain && !lease) continue;
      const kind = plain ? "Force push" : "Force push with lease";
      const all = has("--all") || has("--branches");
      if (refspecs.some((r) => r.unresolved)) {
        out.push(finding(lower("high"), `${kind} to ${refspecs.map((r) => r.raw).join(" ")}; the branch couldn't be resolved.`));
        continue;
      }
      if (refspecs.length === 0 || all) {
        out.push(finding("high", `${kind} with no branch named rewrites ${all ? "every branch" : "the current branch's upstream"}.`));
        continue;
      }
      const branches = refspecs.map((r) => branchOf(r.value));
      const prot = branches.find((b) => PROTECTED.has(b));
      if (prot) out.push(finding("high", `${kind} to ${prot} rewrites shared history.`));
      else out.push(finding(plain ? "medium" : "low", `${kind} to ${branches.join(", ")} rewrites that branch on the remote.`));
    }
    for (const c of unparsedNestedMatching(ctx, /\bgit\b[^;&|]*\bpush\b[^;&|]*(\s-[a-zA-Z]*f|--force|--mirror|\s\+\S)/)) {
      out.push(finding(lower("high"), `A nested script that couldn't be parsed looks like a force push (${c.nestedReason ?? "unparsed"}).`));
    }
    return out;
  },
};
