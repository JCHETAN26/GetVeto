// Turns a shell command string into a flat list of simple commands, using the unbash parser
// (see docs/decisions.md). No top-level side effects, so callers can load it lazily with
// `await import("./shell/parse.js")`. Never throws.
import { forEachChild, parse } from "unbash";
import type { Command, Redirection, SyntaxNode, Word, WordPart } from "unbash";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface Redirect {
  /** Operator as written: ">", ">>", "<", "2>&1"-style ">&", "<<", "<<<", ... */
  op: string;
  /** "file" = a path, "fd" = a file descriptor (e.g. 2>&1), "heredoc", "herestring". */
  kind: "file" | "fd" | "heredoc" | "herestring";
  /** Path / fd / here-string text / heredoc delimiter, with quotes removed. */
  target: string | null;
  /** Source descriptor when written explicitly (the 2 in 2>&1), else null. */
  fd: number | null;
  /** The target contains a variable, substitution, glob or brace expansion we didn't expand. */
  unresolved: boolean;
}

/** One argument word. */
export interface Arg {
  /** Quotes removed; ~, $HOME, ${HOME}, $PWD, $OLDPWD expanded when known. */
  value: string;
  /** As written in the source. */
  raw: string;
  /**
   * Contains something whose value isn't known statically: any other $VAR / ${...},
   * $(...) / `...`, $((...)), <(...), an unquoted glob (*, ?, [..]) or a {a,b} brace
   * expansion. Treat such paths conservatively. `value` keeps that part's source text.
   */
  unresolved: boolean;
}

export interface ParseOptions {
  /** Directory the command starts in; enables $PWD. */
  cwd?: string;
  /** Home directory for ~ and $HOME. Default: os.homedir(). */
  home?: string;
  /** Value of $OLDPWD at the start, if known. */
  oldpwd?: string;
}

export interface SimpleCommand {
  /** Program name with quotes removed, after wrappers are stripped. null for bare assignments. */
  program: string | null;
  /** True when the program word itself isn't known statically (e.g. `$EDITOR file`). */
  programUnresolved: boolean;
  /** Every argument after the program: `value` of each entry in `argWords`. */
  args: string[];
  /** The same arguments with source text and the `unresolved` marker. */
  argWords: Arg[];
  /** The arguments that look like options ("-x", "--long"), up to a "--". */
  flags: string[];
  redirects: Redirect[];
  /** Names of FOO=1 prefixes. */
  assignments: string[];
  /** True when the command is one stage of a multi-command pipeline (a | b). */
  inPipeline: boolean;
  /**
   * Wrappers it was reached through, outermost first: sudo, env, xargs, time, nohup, timeout,
   * nice, command, exec, stdbuf, ionice.
   */
  wrappers: string[];
  /** True when it sits inside $(...), `...` or <(...). */
  inSubstitution: boolean;
  /**
   * Directory this command runs in, following cd / pushd / popd earlier in the same shell.
   * null = unknown (no starting cwd given, `cd $DIR`, `cd -`, a cd inside an if/loop body, ...).
   */
  cwd: string | null;
  /** Source text of this command. */
  text: string;
}

export type ParseResult = { commands: SimpleCommand[] } | { parseError: string };

/** What the shell knows at a point in the script. */
interface State {
  home: string;
  cwd: string | null;
  oldpwd: string | null;
  /** Variables reassigned in the script (HOME=..., export PWD=...): no longer known. */
  reassigned: Set<string>;
  /** pushd/popd stack, top first; null once it's unknown. */
  dirStack: (string | null)[] | null;
}
const cloneState = (s: State): State => ({
  ...s,
  reassigned: new Set(s.reassigned),
  dirStack: s.dirStack && [...s.dirStack],
});

/**
 * Walk a branch that may or may not run (if/while/for/case bodies). Directory changes inside
 * it make the directory afterwards unknown, unless every path leaves it unchanged.
 */
function maybeRuns(st: State, run: (branch: State) => void): void {
  const b = cloneState(st);
  run(b);
  if (b.cwd !== st.cwd) st.cwd = null;
  if (b.oldpwd !== st.oldpwd) st.oldpwd = null;
  if (JSON.stringify(b.dirStack) !== JSON.stringify(st.dirStack)) st.dirStack = null;
  for (const n of b.reassigned) st.reassigned.add(n);
}
const KNOWN_VARS = new Set(["HOME", "PWD", "OLDPWD"]);

interface Ctx {
  inPipeline: boolean;
  inSubstitution: boolean;
  timed: boolean;
  extraRedirects: Redirect[];
}

/**
 * Programs that run another program. `value` = options that take a separate value,
 * `positional` = leading non-option args before the wrapped command (timeout's DURATION),
 * `notWrapper` = options that mean "don't run anything" (command -v npm is a lookup).
 */
interface WrapperSpec {
  value: Set<string>;
  positional?: number;
  notWrapper?: Set<string>;
}
const W = (value: string[], extra: Omit<WrapperSpec, "value"> = {}): WrapperSpec => ({ value: new Set(value), ...extra });
const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: W(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"]),
  env: W(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  xargs: W(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  time: W(["-f", "-o", "--format", "--output"]),
  nohup: W([]),
  timeout: W(["-s", "-k", "--signal", "--kill-after"], { positional: 1 }),
  nice: W(["-n", "--adjustment"]),
  command: W([], { notWrapper: new Set(["-v", "-V"]) }),
  exec: W(["-a"]),
  stdbuf: W(["-i", "-o", "-e", "--input", "--output", "--error"]),
  ionice: W(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]),
};

const isAssignment = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function parseCommand(command: string, opts: ParseOptions = {}): ParseResult {
  try {
    if (typeof command !== "string") return { parseError: "command is not a string" };
    const ast = parse(command);
    const errs = ast.errors ?? [];
    if (errs.length > 0) return { parseError: errs.map((e) => `${e.message} (at ${e.pos})`).join("; ") };
    const out: SimpleCommand[] = [];
    const st: State = {
      home: opts.home ?? homedir(),
      cwd: opts.cwd ? resolve(opts.cwd) : null,
      oldpwd: opts.oldpwd ?? null,
      reassigned: new Set(),
      dirStack: [],
    };
    walk(ast, { inPipeline: false, inSubstitution: false, timed: false, extraRedirects: [] }, st, command, out);
    return { commands: out };
  } catch (e) {
    return { parseError: `parser failure: ${(e as Error)?.message ?? String(e)}` };
  }
}

function walk(node: SyntaxNode, ctx: Ctx, st: State, src: string, out: SimpleCommand[]): void {
  switch (node.type) {
    case "Pipeline": {
      const timed = ctx.timed || node.prefixes.some((p) => p.type === "Time");
      const inPipeline = ctx.inPipeline || node.commands.length > 1;
      // Each stage of a real pipeline runs in its own subshell: a cd there doesn't leak.
      for (const c of node.commands) walk(c, { ...ctx, timed, inPipeline }, inPipeline ? cloneState(st) : st, src, out);
      return;
    }
    case "Statement":
      // `cmd &` runs in the background, in a subshell.
      walk(node.command, ctx, node.background ? cloneState(st) : st, src, out);
      return;
    case "Subshell":
      walk(node.body, ctx, cloneState(st), src, out);
      return;
    case "Function":
      // Defining a function runs nothing; analyze the body on a throwaway state.
      forEachChild(node, (ch) => walk(ch, ctx, cloneState(st), src, out));
      return;
    case "If":
    case "While":
    case "For":
    case "Select":
    case "ArithmeticFor":
    case "Case":
    case "Coproc":
      maybeRuns(st, (b) => forEachChild(node, (ch) => walk(ch, ctx, b, src, out)));
      return;
    case "Redirected": {
      const extra = [...ctx.extraRedirects, ...node.redirects.map((r) => toRedirect(r, st))];
      for (const r of node.redirects) forEachChild(r, (ch) => walk(ch, ctx, cloneState(st), src, out));
      walk(node.command, { ...ctx, extraRedirects: extra }, st, src, out);
      return;
    }
    case "CommandExpansion":
    case "ProcessSubstitution":
    case "ArithmeticCommandExpansion": {
      // Positions in a substitution's script index the outer source, except for escaped
      // backtick scripts, which carry their own decoded `source`.
      const inner = { ...ctx, inSubstitution: true, inPipeline: false, timed: false, extraRedirects: [] };
      if (node.script) walk(node.script, inner, cloneState(st), node.script.source ?? src, out);
      return;
    }
    case "Command": {
      // Substitutions in the words run before the command, against the state before it.
      const before = cloneState(st);
      out.push(simple(node, ctx, st, src));
      forEachChild(node, (ch) => walk(ch, ctx, before, src, out));
      return;
    }
  }
  forEachChild(node, (ch) => walk(ch, ctx, st, src, out));
}

function known(name: string, st: State): string | null {
  if (!KNOWN_VARS.has(name) || st.reassigned.has(name)) return null;
  return name === "HOME" ? st.home : name === "PWD" ? st.cwd : st.oldpwd;
}

/** Leading unquoted ~ or ~/ -> home. ~user/... is left as written (see classifyPath). */
function tilde(text: string, st: State, acc: { unresolved: boolean }): string {
  if (!(text === "~" || text.startsWith("~/"))) return text;
  if (st.reassigned.has("HOME")) {
    acc.unresolved = true;
    return text;
  }
  return st.home + text.slice(1);
}

function expandParts(parts: readonly WordPart[], st: State, quoted: boolean, acc: { v: string; unresolved: boolean }): void {
  parts.forEach((p, idx) => {
    switch (p.type) {
      case "Literal":
        acc.v += !quoted && idx === 0 && acc.v === "" ? tilde(p.value, st, acc) : p.value;
        return;
      case "SingleQuoted":
      case "AnsiCQuoted":
        acc.v += p.value;
        return;
      case "DoubleQuoted":
      case "LocaleString":
        expandParts(p.parts as readonly WordPart[], st, true, acc);
        return;
      case "SimpleExpansion": {
        const val = known(p.text.slice(1), st);
        if (val === null) acc.unresolved = true;
        acc.v += val ?? p.text;
        return;
      }
      case "ParameterExpansion": {
        const val = !p.prefix && !p.index && !p.operation ? known(p.parameter, st) : null;
        if (val === null) acc.unresolved = true;
        acc.v += val ?? p.text;
        return;
      }
      default:
        // Glob, ExtendedGlob, BraceExpansion, CommandExpansion, ArithmeticExpansion,
        // ProcessSubstitution: value unknown until runtime.
        acc.unresolved = true;
        acc.v += p.text;
    }
  });
}

function expandWord(w: Word, st: State): Arg {
  const acc = { v: "", unresolved: false };
  if (!w.parts) return { value: tilde(w.value, st, acc), raw: w.text, unresolved: acc.unresolved };
  expandParts(w.parts, st, false, acc);
  return { value: acc.v, raw: w.text, unresolved: acc.unresolved };
}

function toRedirect(r: Redirection, st: State): Redirect {
  const fd = r.descriptor?.type === "FileDescriptor" ? r.descriptor.value : null;
  if (r.type === "HereDoc") return { op: r.operator, kind: "heredoc", target: r.delimiter?.value ?? null, fd, unresolved: false };
  const t = r.target ? expandWord(r.target, st) : null;
  if (r.type === "HereString") return { op: r.operator, kind: "herestring", target: t?.value ?? "", fd, unresolved: t?.unresolved ?? false };
  const target = t?.value ?? null;
  const dup = (r.operator === ">&" || r.operator === "<&") && target !== null && /^(\d+|-)$/.test(target);
  return { op: r.operator, kind: dup ? "fd" : "file", target, fd, unresolved: t?.unresolved ?? false };
}

function simple(node: Command, ctx: Ctx, st: State, src: string): SimpleCommand {
  const assignments: string[] = [];
  const redirects: Redirect[] = [];
  for (const p of node.prefix) {
    if (p.type === "Assignment") assignments.push(p.name);
    else redirects.push(toRedirect(p, st));
  }
  const words: Arg[] = [];
  if (node.name) words.push(expandWord(node.name, st));
  for (const s of node.suffix) {
    if (s.type === "Word") words.push(expandWord(s, st));
    else if (s.type === "Assignment") words.push({ value: s.text, raw: s.text, unresolved: false });
    else redirects.push(toRedirect(s, st));
  }
  redirects.push(...ctx.extraRedirects);

  const wrappers: string[] = ctx.timed ? ["time"] : [];
  const val = (k: number) => words[k]!.value;
  let i = 0;
  wrap: while (i < words.length) {
    const name = base(val(i));
    const spec = WRAPPERS[name];
    if (!spec) break;
    // `command -v npm` / `command -V npm` look a program up; nothing runs.
    for (let k = i + 1; spec.notWrapper && k < words.length && val(k).startsWith("-") && val(k) !== "--"; k++) {
      if (spec.notWrapper.has(val(k))) break wrap;
    }
    let j = i + 1;
    while (j < words.length) {
      const w = val(j);
      if (w === "--") {
        j++;
        break;
      }
      if (name === "env" && isAssignment(w)) {
        assignments.push(w.slice(0, w.indexOf("=")));
        j++;
        continue;
      }
      if (!w.startsWith("-") || w === "-") break;
      j += spec.value.has(w) ? 2 : 1;
    }
    j += spec.positional ?? 0;
    // Nothing left to wrap: `nice` / `timeout` alone are the program. `exec > log` (redirect
    // only) is the one wrapper that legitimately wraps nothing.
    if (j >= words.length && name !== "exec") break wrap;
    wrappers.push(name);
    i = j;
  }
  const rest = words.slice(i);
  const argWords = rest.slice(1);
  const args = argWords.map((a) => a.value);
  const flags: string[] = [];
  for (const a of args) {
    if (a === "--") break;
    if (a.startsWith("-") && a !== "-") flags.push(a);
  }
  const program = rest[0]?.value ?? null;
  const cwd = st.cwd;
  // Builtins that change directory only work unwrapped (or via `command`).
  if (program !== null && wrappers.every((w) => w === "command")) changeDir(program, argWords, st);

  // Reassigning a variable we expand makes it unknown from here on.
  if (program === null) for (const n of assignments) if (KNOWN_VARS.has(n)) st.reassigned.add(n);
  if (program !== null && ["export", "declare", "typeset", "local", "readonly"].includes(program)) {
    for (const a of args) {
      const n = a.split("=")[0]!;
      if (KNOWN_VARS.has(n) && a.includes("=")) st.reassigned.add(n);
    }
  }

  return {
    program,
    programUnresolved: rest[0]?.unresolved ?? false,
    args,
    argWords,
    flags,
    redirects,
    assignments,
    inPipeline: ctx.inPipeline,
    wrappers,
    inSubstitution: ctx.inSubstitution,
    cwd,
    text: src.slice(node.pos, node.end),
  };
}

/** Where `cd <target>` lands; null if it can't be known statically. */
function cdTarget(target: Arg | undefined, st: State): string | null {
  if (!target) return st.reassigned.has("HOME") ? null : st.home; // bare `cd` -> home
  if (target.unresolved || target.value === "-") return null; // `cd -` -> unknown
  if (isAbsolute(target.value)) return resolve(target.value);
  return st.cwd === null ? null : resolve(st.cwd, target.value);
}

/** Apply cd / pushd / popd to the state. CDPATH is not consulted. */
function changeDir(program: string, args: Arg[], st: State): void {
  if (program !== "cd" && program !== "pushd" && program !== "popd") return;
  let k = 0;
  let noChdir = false;
  while (k < args.length && /^-[LPe@n]+$/.test(args[k]!.value)) {
    if (args[k]!.value.includes("n") && program !== "cd") noChdir = true;
    k++;
  }
  if (args[k]?.value === "--") k++;
  const target = args[k];
  const go = (to: string | null) => {
    st.oldpwd = st.cwd;
    st.cwd = to;
  };

  if (program === "cd") return go(cdTarget(target, st));

  if (target && /^[+-]\d+$/.test(target.value)) {
    // pushd/popd +N / -N rotate or drop stack entries: we don't model that.
    if (!noChdir) go(null);
    st.dirStack = null;
    return;
  }
  if (program === "pushd") {
    if (!target) {
      // swap the top two directories
      if (!st.dirStack || st.dirStack.length === 0) return go(null);
      const top = st.dirStack[0]!;
      st.dirStack[0] = st.cwd;
      return go(top);
    }
    const to = cdTarget(target, st);
    if (noChdir) {
      st.dirStack?.unshift(to);
      return;
    }
    st.dirStack?.unshift(st.cwd);
    return go(to);
  }
  // popd
  if (!st.dirStack || st.dirStack.length === 0) return go(null);
  if (noChdir) {
    st.dirStack.shift();
    return;
  }
  go(st.dirStack.shift()!);
}
