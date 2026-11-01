// Builds rule contexts for unit tests from plain commands, using the real parser.
import { parseCommand, type SimpleCommand } from "../src/shell/parse.js";
import type { Finding, GitStatus, Rule, RuleContext } from "../src/rules/types.js";

export const HOME = "/home/alice";
export const ROOT = "/home/alice/code/app";

export interface CtxOpts {
  cwd?: string | null;
  root?: string;
  home?: string;
  gitStatus?: (dir: string) => GitStatus | null;
}

export function bashCtx(command: string, o: CtxOpts = {}): RuleContext {
  const cwd = o.cwd === undefined ? ROOT : o.cwd;
  const home = o.home ?? HOME;
  const r = parseCommand(command, { cwd: cwd ?? undefined, home });
  if ("parseError" in r) throw new Error(`test command did not parse: ${r.parseError}`);
  return {
    event: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd },
    toolName: "Bash",
    toolInput: { command },
    projectRoot: o.root ?? ROOT,
    home,
    cwd,
    commands: r.commands as SimpleCommand[],
    gitStatus: o.gitStatus ?? (() => null),
  };
}

export function toolCtx(toolName: string, toolInput: Record<string, unknown>, o: CtxOpts = {}): RuleContext {
  const cwd = o.cwd === undefined ? ROOT : o.cwd;
  return {
    event: { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd },
    toolName,
    toolInput,
    projectRoot: o.root ?? ROOT,
    home: o.home ?? HOME,
    cwd,
    commands: [],
    gitStatus: o.gitStatus ?? (() => null),
  };
}

/** Findings of one rule for a Bash command. */
export const runBash = (rule: Rule, command: string, o?: CtxOpts): Finding[] => rule.check(bashCtx(command, o));

/** Highest severity, or null when the rule didn't match. */
export function sev(findings: Finding[]): Finding["severity"] | null {
  const order = ["high", "medium", "low"] as const;
  return order.find((s) => findings.some((f) => f.severity === s)) ?? null;
}
