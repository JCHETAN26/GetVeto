// Turns a shell command string into a flat list of simple commands, using the unbash parser
// (see docs/decisions.md). No top-level side effects, so callers can load it lazily with
// `await import("./shell/parse.js")`. Never throws.
import { forEachChild, parse } from "unbash";
import type { Command, Redirection, SyntaxNode, Word } from "unbash";

export interface Redirect {
  /** Operator as written: ">", ">>", "<", "2>&1"-style ">&", "<<", "<<<", ... */
  op: string;
  /** "file" = a path, "fd" = a file descriptor (e.g. 2>&1), "heredoc", "herestring". */
  kind: "file" | "fd" | "heredoc" | "herestring";
  /** Path / fd / here-string text / heredoc delimiter, with quotes removed. */
  target: string | null;
  /** Source descriptor when written explicitly (the 2 in 2>&1), else null. */
  fd: number | null;
}

export interface SimpleCommand {
  /** Program name with quotes removed, after wrappers are stripped. null for bare assignments. */
  program: string | null;
  /** Every argument after the program, quotes removed. */
  args: string[];
  /** The arguments that look like options ("-x", "--long"), up to a "--". */
  flags: string[];
  redirects: Redirect[];
  /** Names of FOO=1 prefixes. */
  assignments: string[];
  /** True when the command is one stage of a multi-command pipeline (a | b). */
  inPipeline: boolean;
  /** Wrappers it was reached through, outermost first: sudo, env, xargs, time, nohup. */
  wrappers: string[];
  /** True when it sits inside $(...), `...` or <(...). */
  inSubstitution: boolean;
  /** Source text of this command. */
  text: string;
}

export type ParseResult = { commands: SimpleCommand[] } | { parseError: string };

interface Ctx {
  inPipeline: boolean;
  inSubstitution: boolean;
  timed: boolean;
  extraRedirects: Redirect[];
}

/** Options that take a separate value, per wrapper. */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
  env: new Set(["-u", "-C", "-S"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"]),
  time: new Set(["-f", "-o"]),
  nohup: new Set(),
};

const isAssignment = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function parseCommand(command: string): ParseResult {
  try {
    if (typeof command !== "string") return { parseError: "command is not a string" };
    const ast = parse(command);
    const errs = ast.errors ?? [];
    if (errs.length > 0) return { parseError: errs.map((e) => `${e.message} (at ${e.pos})`).join("; ") };
    const out: SimpleCommand[] = [];
    walk(ast, { inPipeline: false, inSubstitution: false, timed: false, extraRedirects: [] }, command, out);
    return { commands: out };
  } catch (e) {
    return { parseError: `parser failure: ${(e as Error)?.message ?? String(e)}` };
  }
}

function walk(node: SyntaxNode, ctx: Ctx, src: string, out: SimpleCommand[]): void {
  switch (node.type) {
    case "Pipeline": {
      const timed = ctx.timed || node.prefixes.some((p) => p.type === "Time");
      const inPipeline = ctx.inPipeline || node.commands.length > 1;
      for (const c of node.commands) walk(c, { ...ctx, timed, inPipeline }, src, out);
      return;
    }
    case "Redirected": {
      const extra = [...ctx.extraRedirects, ...node.redirects.map(toRedirect)];
      walk(node.command, { ...ctx, extraRedirects: extra }, src, out);
      for (const r of node.redirects) forEachChild(r, (ch) => walk(ch, ctx, src, out));
      return;
    }
    case "CommandExpansion":
    case "ProcessSubstitution":
    case "ArithmeticCommandExpansion": {
      // Positions in a substitution's script index the outer source, except for escaped
      // backtick scripts, which carry their own decoded `source`.
      const inner = { ...ctx, inSubstitution: true, inPipeline: false, timed: false, extraRedirects: [] };
      if (node.script) walk(node.script, inner, node.script.source ?? src, out);
      return;
    }
    case "Command":
      out.push(simple(node, ctx, src));
      break;
  }
  forEachChild(node, (ch) => walk(ch, ctx, src, out));
}

function wordText(w: Word | undefined): string {
  return w ? w.value : "";
}

function toRedirect(r: Redirection): Redirect {
  const fd = r.descriptor?.type === "FileDescriptor" ? r.descriptor.value : null;
  if (r.type === "HereDoc") return { op: r.operator, kind: "heredoc", target: r.delimiter?.value ?? null, fd };
  if (r.type === "HereString") return { op: r.operator, kind: "herestring", target: wordText(r.target), fd };
  const target = r.target ? r.target.value : null;
  const dup = (r.operator === ">&" || r.operator === "<&") && target !== null && /^(\d+|-)$/.test(target);
  return { op: r.operator, kind: dup ? "fd" : "file", target, fd };
}

function simple(node: Command, ctx: Ctx, src: string): SimpleCommand {
  const assignments: string[] = [];
  const redirects: Redirect[] = [];
  for (const p of node.prefix) {
    if (p.type === "Assignment") assignments.push(p.name);
    else redirects.push(toRedirect(p));
  }
  const words: string[] = [];
  if (node.name) words.push(node.name.value);
  for (const s of node.suffix) {
    if (s.type === "Word") words.push(s.value);
    else if (s.type === "Assignment") words.push(s.text);
    else redirects.push(toRedirect(s));
  }
  redirects.push(...ctx.extraRedirects);

  const wrappers: string[] = ctx.timed ? ["time"] : [];
  let i = 0;
  while (i < words.length) {
    const name = base(words[i]!);
    const valueOpts = WRAPPER_VALUE_OPTS[name];
    if (!valueOpts) break;
    wrappers.push(name);
    i++;
    while (i < words.length) {
      const w = words[i]!;
      if (w === "--") {
        i++;
        break;
      }
      if (name === "env" && isAssignment(w)) {
        assignments.push(w.slice(0, w.indexOf("=")));
        i++;
        continue;
      }
      if (!w.startsWith("-") || w === "-") break;
      i += valueOpts.has(w) ? 2 : 1;
    }
  }
  const rest = words.slice(i);
  const program = rest.length > 0 ? rest[0]! : null;
  const args = rest.slice(1);
  const flags: string[] = [];
  for (const a of args) {
    if (a === "--") break;
    if (a.startsWith("-") && a !== "-") flags.push(a);
  }
  return {
    program,
    args,
    flags,
    redirects,
    assignments,
    inPipeline: ctx.inPipeline,
    wrappers,
    inSubstitution: ctx.inSubstitution,
    text: src.slice(node.pos, node.end),
  };
}
