// Helpers shared by rules: splitting arguments into options and operands, resolving path
// operands conservatively, and spotting commands inside nested scripts we couldn't parse.
import { relative, sep } from "node:path";
import type { Arg, SimpleCommand } from "../shell/parse.js";
import { classifyPath, resolvePath, type PathClass } from "../shell/paths.js";
import type { RuleContext } from "./types.js";

export interface SplitArgs {
  /** Option words ("-rf", "--force", "--force-with-lease=main") before any "--". */
  options: string[];
  /** Everything else, in order (all words after "--" count as operands). */
  operands: Arg[];
}

export function splitArgs(words: Arg[]): SplitArgs {
  const options: string[] = [];
  const operands: Arg[] = [];
  let endOfOptions = false;
  for (const w of words) {
    if (!endOfOptions && w.value === "--" && !w.unresolved) {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && !w.unresolved && w.value.length > 1 && w.value.startsWith("-")) options.push(w.value);
    else operands.push(w);
  }
  return { options, operands };
}

/** A short option letter, alone or in a cluster: hasShort(["-rf"], "r") is true. */
export function hasShort(options: string[], letter: string): boolean {
  return options.some((o) => /^-[^-]/.test(o) && o.slice(1).includes(letter));
}

/** A long option, bare or with =value. */
export function hasLong(options: string[], name: string): boolean {
  return options.some((o) => o === name || o.startsWith(name + "="));
}

export interface Target {
  /** Where the path (or, for a glob, the directory it expands in) falls. */
  cls: PathClass;
  /** Absolute path of the target, or of the directory a glob expands in. null when unknown. */
  abs: string | null;
  /**
   * false: the argument had a glob, brace expansion or variable. When abs is set, every path
   * it can expand to lies under abs (no variables or ".." after the fixed prefix).
   */
  exact: boolean;
}

const UNRESOLVED_CHARS = /[*?[{$`(]/;

/** Resolve a path operand of a command running in `cwd`. */
export function resolveTarget(arg: Arg, cwd: string | null, ctx: RuleContext): Target {
  if (!arg.unresolved) {
    const cls = classifyPath(arg.value, cwd, ctx.projectRoot, ctx.home);
    const abs = cls === "unknown" ? null : resolvePath(arg.value, cwd ?? "/", ctx.home);
    return { cls, abs, exact: true };
  }
  const v = arg.value;
  const i = v.search(UNRESOLVED_CHARS);
  const cut = i < 0 ? v.length : i;
  const dir = v.slice(0, v.lastIndexOf("/", cut) + 1);
  const rest = v.slice(dir.length);
  // A variable or substitution after the fixed prefix could hold "/" or "..": can't bound it.
  if (/[$`]/.test(rest) || /(^|\/)\.\.(\/|$)/.test(rest)) return { cls: "unknown", abs: null, exact: false };
  const base = dir === "" ? "." : dir;
  const cls = classifyPath(base, cwd, ctx.projectRoot, ctx.home);
  return { cls, abs: cls === "unknown" ? null : resolvePath(base, cwd ?? "/", ctx.home), exact: false };
}

/** Path relative to the project root, split into segments ([] for the root itself). */
export function projectSegments(abs: string, ctx: RuleContext): string[] {
  const rel = relative(ctx.projectRoot, abs);
  return rel === "" ? [] : rel.split(sep);
}

/** ~/x for paths under home, the path as-is otherwise. */
export function display(abs: string | null, arg: Arg, ctx: RuleContext): string {
  if (abs === null) return arg.raw;
  if (abs === ctx.home) return "~";
  if (abs.startsWith(ctx.home + sep)) return "~" + abs.slice(ctx.home.length);
  return abs;
}

/**
 * Commands whose nested script (bash -c / eval) wasn't parsed but whose text matches `re`.
 * Rules use this to treat a likely match conservatively.
 */
export function unparsedNestedMatching(ctx: RuleContext, re: RegExp): SimpleCommand[] {
  return ctx.commands.filter((c) => c.unparsedNested && re.test(c.text));
}

/** Arguments arrive on stdin (xargs), so the real operands aren't known. */
export const operandsFromStdin = (c: SimpleCommand) => c.wrappers.includes("xargs");
