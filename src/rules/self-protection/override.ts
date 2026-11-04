// The agent must not be able to switch Veto off for itself. Overrides are the user's call, made
// in their own terminal: `veto allow ...`, `veto mode watch` and `veto uninstall` run by the
// agent through Bash are high, and so are writes into the project's .veto/ folder (config,
// overrides, log) through Write/Edit or a shell redirect.
//
// Not covered (README "What Veto does not cover"): other ways to reach the same files (cp, sed
// -i, a script), and editing .claude/settings*.json to remove the hook.
import { relative, sep } from "node:path";
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import { resolvePath } from "../../shell/paths.js";
import { unparsedNestedMatching } from "../args.js";
import type { Finding, Rule, RuleContext } from "../types.js";

const ID = "self-protection/override";
const TIP = "Tell the user what you want to do and why; if they agree, they can run `veto allow --once` in their own terminal and ask you to retry.";
const finding = (reason: string): Finding => ({ ruleId: ID, category: "self-protection", severity: "high", reason, suggestion: TIP });

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** A path that runs the Veto CLI: .../getveto/dist/cli.js, or any dist/cli.js or veto.js in a getveto folder. */
const VETO_SCRIPT = /(^|\/)getveto(\/dist\/(cli|veto)\.js)?$|(^|\/)dist\/cli\.js$/;

/** The Veto subcommand words when `c` runs the Veto CLI, else null. */
function vetoArgs(c: SimpleCommand): Arg[] | null {
  if (c.program === null || c.programUnresolved) return null;
  const prog = base(c.program);
  const w = c.argWords;
  if (prog === "veto" || prog === "getveto") return w;
  if (prog === "node" || prog === "bun") {
    const i = w.findIndex((a) => !a.value.startsWith("-"));
    return i >= 0 && VETO_SCRIPT.test(w[i]!.value) ? w.slice(i + 1) : null;
  }
  if (prog === "npx" || prog === "bunx" || prog === "pnpx") {
    const i = w.findIndex((a) => !a.value.startsWith("-"));
    return i >= 0 && /^(getveto|veto)(@.*)?$/.test(w[i]!.value) ? w.slice(i + 1) : null;
  }
  return null;
}

function vetoCommand(c: SimpleCommand): string | null {
  const a = vetoArgs(c);
  if (!a || a.length === 0) return null;
  const sub = a[0]!;
  if (sub.unresolved) return `Veto CLI with a subcommand that couldn't be resolved (${sub.raw})`;
  if (sub.value === "allow") return "veto allow";
  if (sub.value === "uninstall") return "veto uninstall";
  if (sub.value === "mode" && a[1] && (a[1].unresolved || a[1].value === "watch")) return "veto mode watch";
  return null;
}

/** Is abs inside <project>/.veto or <project>/.claude/settings*.json? */
function inProtectedTarget(abs: string, ctx: RuleContext): "veto" | "claude" | null {
  const rel = relative(ctx.projectRoot, abs);
  if (rel === ".veto" || rel.startsWith(".veto" + sep)) return "veto";
  if (rel.startsWith(".claude" + sep) && rel.includes("settings")) return "claude";
  return null;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export const selfOverride: Rule = {
  id: ID,
  category: "self-protection",
  // Words that appear in every case above: the CLI's name, its script, the .veto folder, or .claude settings.
  // (Bash only: file tools always reach check.)
  triggers: ["veto", "getveto", "cli.js", "veto.js", ".veto", ".claude"],
  check(ctx) {
    const out: Finding[] = [];
    if (FILE_TOOLS.has(ctx.toolName ?? "")) {
      const p = ctx.toolInput.file_path ?? ctx.toolInput.notebook_path;
      if (typeof p === "string" && p !== "") {
        const prot = inProtectedTarget(resolvePath(p, ctx.cwd ?? ctx.projectRoot, ctx.home), ctx);
        if (prot === "veto") {
          out.push(finding(`${ctx.toolName} on Veto's own files (${p}) could change what Veto blocks; only the user should edit .veto/.`));
        } else if (prot === "claude") {
          out.push(finding(`${ctx.toolName} on Claude Code settings (${p}) could disable Veto's hook; only the user should edit hook settings.`));
        }
      }
      return out;
    }
    for (const c of ctx.commands) {
      const v = vetoCommand(c);
      if (v) out.push(finding(`${v} run by the agent would override Veto; the user must run it in their own terminal.`));
      for (const r of c.redirects) {
        if (r.kind !== "file" || !r.op.includes(">") || r.target === null || r.unresolved) continue;
        const prot = inProtectedTarget(resolvePath(r.target, c.cwd ?? ctx.projectRoot, ctx.home), ctx);
        if (prot === "veto") {
          out.push(finding(`A shell redirect writes to Veto's own files (${r.target}); only the user should edit .veto/.`));
        } else if (prot === "claude") {
          out.push(finding(`A shell redirect writes to Claude Code settings (${r.target}); only the user should edit hook settings.`));
        }
      }
    }
    for (const c of unparsedNestedMatching(ctx, /\bveto\b[^;&|]*\b(allow|uninstall|mode\s+watch)\b/)) {
      out.push(finding(`A nested script that couldn't be parsed looks like it overrides Veto (${c.nestedReason ?? "unparsed"}).`));
    }
    return out;
  },
};
