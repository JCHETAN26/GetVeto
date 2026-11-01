// Splits a `git ...` command into its subcommand and arguments, and works out which work
// tree it acts on (following -C and --work-tree like git does).
import type { Arg, SimpleCommand } from "../shell/parse.js";
import { resolvePath } from "../shell/paths.js";
import type { RuleContext } from "./types.js";

export interface GitCall {
  sub: string;
  args: Arg[];
  /** Directory git runs in, or null when it isn't known statically. */
  dir: string | null;
}

/** Global options that take a separate value word. */
const VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

export function gitCall(c: SimpleCommand, ctx: RuleContext): GitCall | null {
  if (c.program !== "git" || c.programUnresolved) return null;
  let dir = c.cwd;
  const w = c.argWords;
  let i = 0;
  for (; i < w.length; i++) {
    const a = w[i]!;
    if (a.unresolved || !a.value.startsWith("-")) break;
    const [name, inline] = a.value.includes("=") ? [a.value.slice(0, a.value.indexOf("=")), a.value.slice(a.value.indexOf("=") + 1)] : [a.value, undefined];
    let value: Arg | undefined;
    if (VALUE_OPTS.has(name) && inline === undefined) value = w[++i];
    const v = inline !== undefined ? { value: inline, unresolved: a.unresolved } : value;
    if (name === "-C" || name === "--work-tree") {
      if (!v || v.unresolved) dir = null;
      else if (dir !== null || v.value.startsWith("/") || v.value.startsWith("~")) dir = resolvePath(v.value, dir ?? "/", ctx.home);
    }
  }
  const sub = w[i];
  if (!sub || sub.unresolved) return null;
  return { sub: sub.value, args: w.slice(i + 1), dir };
}
