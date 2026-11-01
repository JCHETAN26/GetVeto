// Broad operations: find -delete / -exec rm outside the project, chmod/chown/chgrp -R on home
// or system paths, dd, and mkfs.
import { basename } from "node:path";
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import { display, hasLong, hasShort, resolveTarget, splitArgs, unparsedNestedMatching, type Target } from "../args.js";
import { lower, type Finding, type Rule, type RuleContext, type Severity } from "../types.js";

const ID = "destructive/broad";
const finding = (severity: Severity, reason: string): Finding => ({ ruleId: ID, category: "destructive", severity, reason });

const PLACE: Record<string, string> = { home: "your home directory", system: "a system location", "outside-project": "outside the project" };

/** Severity for a path target given the per-class severities; null = not flagged. */
function judge(t: Target, bySeverity: Partial<Record<string, Severity>>): Severity | null {
  if (t.abs === null) return lower("high");
  const s = bySeverity[t.cls];
  if (!s) return null;
  return t.exact ? s : lower(s);
}

function where(t: Target, arg: Arg, ctx: RuleContext): string {
  if (t.abs === null) return `${arg.raw}, which couldn't be resolved`;
  return `${PLACE[t.cls] ?? t.cls} (${display(t.abs, arg, ctx)})${t.exact ? "" : ", not fully resolved"}`;
}

function findRule(c: SimpleCommand, ctx: RuleContext): Finding[] {
  const w = c.argWords;
  let i = 0;
  while (i < w.length && /^-(H|L|P|O\d*)$/.test(w[i]!.value)) i++;
  if (w[i]?.value === "-D") i += 2;
  const starts: Arg[] = [];
  for (; i < w.length && !/^[-(!,]/.test(w[i]!.value); i++) starts.push(w[i]!);
  const expr = w.slice(i).map((a) => a.value);
  const deletes = expr.includes("-delete");
  const execRm = expr.some((v, j) => {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(v)) return false;
    const prog = basename(expr[j + 1] ?? "");
    if (prog === "rm") return true;
    return ["sh", "bash", "zsh", "dash"].includes(prog) && expr[j + 2] === "-c" && /\brm\b/.test(expr[j + 3] ?? "");
  });
  if (!deletes && !execRm) return [];
  const action = deletes ? "find -delete" : "find -exec rm";
  if (starts.length === 0) starts.push({ value: ".", raw: ".", unresolved: false });
  const out: Finding[] = [];
  for (const arg of starts) {
    const t = resolveTarget(arg, c.cwd, ctx);
    const sev = judge(t, { home: "high", system: "high", "outside-project": "medium" });
    if (sev) out.push(finding(sev, `${action} in ${where(t, arg, ctx)}.`));
  }
  return out;
}

function permsRule(c: SimpleCommand, ctx: RuleContext): Finding[] {
  const { options, operands } = splitArgs(c.argWords);
  if (!hasShort(options, "R") && !hasLong(options, "--recursive")) return [];
  const paths = hasLong(options, "--reference") ? operands : operands.slice(1);
  const out: Finding[] = [];
  for (const arg of paths) {
    const t = resolveTarget(arg, c.cwd, ctx);
    const sev = judge(t, { home: "high", system: "high" });
    if (sev) out.push(finding(sev, `${c.program} -R on ${where(t, arg, ctx)}.`));
  }
  return out;
}

const HARMLESS_DEV = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/;

function ddRule(c: SimpleCommand, ctx: RuleContext): Finding[] {
  const of = c.argWords.find((a) => a.value.startsWith("of="));
  if (!of) return [finding("low", "dd copies raw data; check its input and output.")];
  const target: Arg = { value: of.value.slice(3), raw: of.raw.replace(/^of=/, ""), unresolved: of.unresolved };
  if (!target.unresolved && target.value.startsWith("/dev/") && !HARMLESS_DEV.test(target.value)) {
    return [finding("high", `dd writes directly to the device ${target.value}.`)];
  }
  const t = resolveTarget(target, c.cwd, ctx);
  if (t.cls === "inside-project") return [finding("low", `dd writes raw data to ${display(t.abs, target, ctx)} in the project.`)];
  if (!target.unresolved && HARMLESS_DEV.test(target.value)) return [finding("low", "dd copies raw data; check its input and output.")];
  return [finding("medium", `dd writes raw data to ${where(t, target, ctx)}.`)];
}

export const broad: Rule = {
  id: ID,
  category: "destructive",
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      if (c.programUnresolved || !c.program) continue;
      const p = c.program;
      if (p === "find") out.push(...findRule(c, ctx));
      else if (p === "chmod" || p === "chown" || p === "chgrp") out.push(...permsRule(c, ctx));
      else if (p === "dd") out.push(...ddRule(c, ctx));
      else if (p === "mkfs" || p.startsWith("mkfs.") || p === "mke2fs") out.push(finding("high", `${p} formats a filesystem, erasing what was on it.`));
    }
    const nested = /\b(find\b[^;&|]*(-delete|-exec\s+rm)|ch(mod|own|grp)\s+(\S+\s+)*-[a-zA-Z]*R|mkfs|\bdd\s)/;
    for (const c of unparsedNestedMatching(ctx, nested)) {
      out.push(finding(lower("high"), `A nested script that couldn't be parsed contains a broad delete, permission or disk command (${c.nestedReason ?? "unparsed"}).`));
    }
    return out;
  },
};
