// Non-recursive deletion of files outside the project: rm (without -r; recursive-rm covers
// that), unlink, shred, truncate -s 0. Also mv of a file from outside the project into the
// project or /dev/null, which takes it out of where the user keeps it.
// Deleting or moving project files is normal dev work and is not flagged.
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import { display, hasLong, hasShort, operandsFromStdin, resolveTarget, splitArgs, unparsedNestedMatching } from "../args.js";
import type { Finding, Rule, RuleContext, Severity } from "../types.js";

const ID = "destructive/delete-outside-project";
const DELETE_TIP = "Confirm with the user before deleting files outside the project, or work inside the project.";
const MOVE_TIP = "Copy the file (cp) instead of moving it, or confirm with the user first.";
const finding = (severity: Severity, reason: string, suggestion = DELETE_TIP): Finding => ({ ruleId: ID, category: "destructive", severity, reason, suggestion });

const PLACE: Record<string, string> = { home: "your home directory", system: "a system location", "outside-project": "outside the project" };
const SEVERITY: Record<string, Severity> = { home: "medium", "outside-project": "medium", system: "high" };

/** Split arguments when some options take a separate value word. */
function operandsWithValues(words: Arg[], valueOpts: Set<string>): { options: string[]; operands: Arg[] } {
  const options: string[] = [];
  const operands: Arg[] = [];
  let end = false;
  for (let i = 0; i < words.length; i++) {
    const a = words[i]!;
    if (!end && a.value === "--" && !a.unresolved) end = true;
    else if (!end && !a.unresolved && a.value.startsWith("-") && a.value.length > 1) {
      options.push(a.value);
      if (valueOpts.has(a.value)) options.push(words[++i]?.value ?? "");
    } else operands.push(a);
  }
  return { options, operands };
}

/** "truncate -s 0" in any spelling: -s 0, -s0, --size 0, --size=0. */
function truncatesToZero(words: Arg[]): boolean {
  return words.some((a, i) => {
    const v = a.value;
    if (v === "-s" || v === "--size") return words[i + 1]?.value === "0";
    return v === "-s0" || v === "--size=0";
  });
}

/** Files this command deletes, and what to call the action; null if it isn't a delete. */
function deleted(c: SimpleCommand): { verb: string; targets: Arg[] } | null {
  switch (c.program) {
    case "rm": {
      const { options, operands } = splitArgs(c.argWords);
      if (hasShort(options, "r") || hasShort(options, "R") || hasLong(options, "--recursive")) return null; // recursive-rm
      return { verb: "rm deletes", targets: operands };
    }
    case "unlink":
      return { verb: "unlink deletes", targets: splitArgs(c.argWords).operands };
    case "shred":
      return { verb: "shred destroys", targets: operandsWithValues(c.argWords, new Set(["-n", "-s", "--iterations", "--size", "--random-source"])).operands };
    case "truncate":
      if (!truncatesToZero(c.argWords)) return null;
      return { verb: "truncate -s 0 empties", targets: operandsWithValues(c.argWords, new Set(["-s", "--size", "-r", "--reference"])).operands };
    default:
      return null;
  }
}

function checkDelete(c: SimpleCommand, ctx: RuleContext): Finding[] {
  const d = deleted(c);
  if (!d) return [];
  if (d.targets.length === 0 && operandsFromStdin(c)) {
    return [finding("low", `${d.verb} files read from input (xargs); the targets couldn't be resolved.`)];
  }
  const out: Finding[] = [];
  for (const arg of d.targets) {
    const t = resolveTarget(arg, c.cwd, ctx);
    if (t.cls === "inside-project") continue; // also a glob bounded inside the project
    if (t.abs === null || !t.exact) {
      out.push(finding("low", `${d.verb} ${arg.raw}; the path couldn't be resolved.`));
      continue;
    }
    out.push(finding(SEVERITY[t.cls] ?? "medium", `${d.verb} a file in ${PLACE[t.cls] ?? t.cls} (${display(t.abs, arg, ctx)}).`));
  }
  return out;
}

function checkMove(c: SimpleCommand, ctx: RuleContext): Finding[] {
  if (c.program !== "mv") return [];
  const { options, operands } = operandsWithValues(c.argWords, new Set(["-t", "--target-directory", "-S", "--suffix"]));
  const tIdx = options.findIndex((o) => o === "-t" || o === "--target-directory");
  const tInline = options.find((o) => o.startsWith("--target-directory="));
  let dest: Arg | undefined;
  let sources: Arg[];
  if (tIdx >= 0 || tInline) {
    const value = tInline ? tInline.slice("--target-directory=".length) : options[tIdx + 1]!;
    dest = { value, raw: value, unresolved: false };
    sources = operands;
  } else {
    dest = operands.at(-1);
    sources = operands.slice(0, -1);
  }
  if (!dest || sources.length === 0) return [];
  const devNull = !dest.unresolved && dest.value === "/dev/null";
  const dt = resolveTarget(dest, c.cwd, ctx);
  // Into the project (a glob bounded inside it counts) or /dev/null; unknown is judged lower.
  const destIn = devNull || dt.cls === "inside-project";
  const destUnknown = !destIn && dt.abs === null;
  if (!destIn && !destUnknown) return [];
  const into = devNull ? "/dev/null" : "the project";
  const out: Finding[] = [];
  for (const arg of sources) {
    const st = resolveTarget(arg, c.cwd, ctx);
    if (st.cls === "inside-project") continue;
    const srcUnknown = st.abs === null || !st.exact;
    if (srcUnknown || destUnknown) {
      out.push(finding("low", `mv of ${arg.raw} into ${destUnknown ? dest.raw : into}; the paths couldn't be resolved.`, MOVE_TIP));
    } else {
      out.push(finding("medium", `mv moves a file out of ${PLACE[st.cls] ?? st.cls} (${display(st.abs, arg, ctx)}) into ${into}.`, MOVE_TIP));
    }
  }
  return out;
}

export const deleteOutsideProject: Rule = {
  id: ID,
  category: "destructive",
  triggers: ["rm", "unlink", "shred", "truncate", "mv"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      if (c.programUnresolved) continue;
      out.push(...checkDelete(c, ctx), ...checkMove(c, ctx));
    }
    for (const c of unparsedNestedMatching(ctx, /\b(rm|unlink|shred|mv)\s|\btruncate\b[^;&|]*-s\s*0/)) {
      out.push(finding("low", `A nested script that couldn't be parsed may delete or move files (${c.nestedReason ?? "unparsed"}).`));
    }
    return out;
  },
};
