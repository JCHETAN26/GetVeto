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

/** What a `git stash ...` call saves before it cleans the work tree. */
export interface StashSave {
  /** -u / --include-untracked or -a / --all: untracked files are saved (and removed) too. */
  untracked: boolean;
  /** -a / --all: ignored files too. */
  ignored: boolean;
}

/** Short options of `git stash push` that take no value. */
const STASH_FLAGS: Record<string, keyof StashSave | null> = { u: "untracked", a: "ignored", k: null, q: null };
const STASH_LONG: Record<string, keyof StashSave | null> = {
  "--include-untracked": "untracked",
  "--all": "ignored",
  "--keep-index": null,
  "--no-keep-index": null,
  "--quiet": null,
  "--no-include-untracked": null,
};

/**
 * `args` are the words after `git stash`. Returns what the call saves when it is a plain
 * `git stash`, `git stash push` or `git stash save` that stashes every change in the work
 * tree. null for anything else: list/show/pop/apply/drop/..., a partial stash (-p, --staged,
 * pathspecs, --pathspec-from-file), or an option we don't know or can't read.
 */
export function stashSaves(args: Arg[]): StashSave | null {
  let rest = args;
  let save = false;
  const first = args[0];
  if (first && !first.value.startsWith("-")) {
    if (first.unresolved || (first.value !== "push" && first.value !== "save")) return null;
    save = first.value === "save";
    rest = args.slice(1);
  }
  const out: StashSave = { untracked: false, ignored: false };
  const set = (k: keyof StashSave | null) => {
    if (k === "ignored") out.untracked = out.ignored = true;
    else if (k === "untracked") out.untracked = true;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.unresolved) return save ? out : null; // `save` takes a message; push would take pathspecs
    const v = a.value;
    // After `--`, push takes pathspecs (partial stash) and save takes the message.
    if (v === "--") return save || i === rest.length - 1 ? out : null;
    if (!v.startsWith("-") || v === "-") {
      if (save) return out; // the rest is the message
      return null; // a pathspec: only part of the work tree is stashed
    }
    if (v.startsWith("--")) {
      const name = v.includes("=") ? v.slice(0, v.indexOf("=")) : v;
      if (name === "--message") {
        if (!v.includes("=")) i++;
        continue;
      }
      if (!(name in STASH_LONG) || v.includes("=")) return null;
      set(STASH_LONG[name]!);
      continue;
    }
    // A cluster of short options, e.g. -ku or -um"msg".
    for (let k = 1; k < v.length; k++) {
      const ch = v[k]!;
      if (ch === "m") {
        if (k === v.length - 1) i++; // the message is the next word
        break;
      }
      if (!(ch in STASH_FLAGS)) return null; // -p (patch), -S (staged), anything unknown
      set(STASH_FLAGS[ch]!);
    }
  }
  return out;
}

/** `git stash drop` / `git stash clear`. */
export const isStashDelete = (g: GitCall) => g.sub === "stash" && !g.args[0]?.unresolved && (g.args[0]?.value === "drop" || g.args[0]?.value === "clear");
