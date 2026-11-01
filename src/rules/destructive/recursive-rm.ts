// rm -r / -R / --recursive on anything that isn't a regenerable folder inside the project.
import { display, hasLong, hasShort, operandsFromStdin, projectSegments, resolveTarget, splitArgs, unparsedNestedMatching } from "../args.js";
import { lower, type Finding, type Rule, type RuleContext, type Severity } from "../types.js";

const ID = "destructive/recursive-rm";

/** Build output and caches: safe to delete because a build or install recreates them. */
export const REGENERABLE = new Set(["dist", "build", "out", "node_modules", ".cache", "coverage", "tmp", ".next", ".turbo"]);

const SUGGESTION = "Delete only build output inside the project (dist, build, node_modules, ...), or confirm the exact paths with the user first.";
const finding = (severity: Severity, reason: string): Finding => ({ ruleId: ID, category: "destructive", severity, reason, suggestion: SUGGESTION });

/** Severity for deleting abs (or everything under it), or null when it's fine. */
function judge(abs: string, cls: string, ctx: RuleContext): { severity: Severity; what: string } | null {
  if (cls === "inside-project") {
    const segs = projectSegments(abs, ctx);
    if (segs.length === 0) return { severity: "high", what: "the project root" };
    if (segs.some((s) => REGENERABLE.has(s))) return null;
    return { severity: "medium", what: "project files" };
  }
  if (cls === "home") return { severity: "high", what: "your home directory" };
  if (cls === "system") return { severity: "high", what: "a system location" };
  return { severity: "medium", what: "a location outside the project" }; // e.g. /tmp, other mounts
}

export const recursiveRm: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["rm"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      if (c.program !== "rm" || c.programUnresolved) continue;
      const { options, operands } = splitArgs(c.argWords);
      if (!hasShort(options, "r") && !hasShort(options, "R") && !hasLong(options, "--recursive")) continue;
      if (operands.length === 0 && operandsFromStdin(c)) {
        out.push(finding("medium", "Recursive delete of paths read from input (xargs); the targets couldn't be resolved."));
      }
      for (const arg of operands) {
        const t = resolveTarget(arg, c.cwd, ctx);
        if (t.abs === null) {
          out.push(finding(lower("high"), `Recursive delete of ${arg.raw}; the path couldn't be resolved.`));
          continue;
        }
        const j = judge(t.abs, t.cls, ctx);
        if (!j) continue;
        const where = display(t.abs, arg, ctx);
        out.push(
          t.exact
            ? finding(j.severity, `Recursive delete of ${j.what} (${where}).`)
            : finding(lower(j.severity), `Recursive delete matching ${arg.raw} in ${j.what} (${where}); the exact paths couldn't be resolved.`),
        );
      }
    }
    for (const c of unparsedNestedMatching(ctx, /\brm\s+(\S+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/)) {
      out.push(finding(lower("high"), `Recursive delete inside a nested script that couldn't be parsed (${c.nestedReason ?? "unparsed"}).`));
    }
    return out;
  },
};
