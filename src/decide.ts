// Guard mode: turn the engine's verdict into what the hook tells Claude Code.
// Only "deny" and "ask" are ever output (docs/hooks-research.md §7). Watch mode, no findings,
// findings whose action is "log", and engine errors all mean no decision: exit 0, empty stdout.
// Never "allow": that would skip the user's own permission prompt.
import type { Action, VetoConfig } from "./config.js";
import type { Verdict } from "./rules/engine.js";
import type { Finding } from "./rules/types.js";

/** What happened to the call, as recorded in the log. */
export type Decision = "allowed" | "asked" | "denied";

export interface GuardResult {
  decision: Decision;
  /** The findings that caused the deny/ask (empty when allowed). */
  because: Finding[];
  /** Exactly what the hook prints on stdout ("" = no decision). */
  stdout: string;
}

const RANK: Record<Action, number> = { log: 0, ask: 1, deny: 2 };
const MAX_LISTED = 5;
/** Docs cap additionalContext at 10,000 chars; stay well under for the reason too. */
const MAX_REASON = 2000;

/** "Veto: ..." text naming each rule, its specific target, and the safer alternatives. */
export function formatReason(action: "deny" | "ask", findings: Finding[]): string {
  const head = action === "deny" ? "Veto: blocked this call." : "Veto: asking the user to confirm this call.";
  const listed = findings.slice(0, MAX_LISTED).map((f) => `[${f.ruleId}] ${f.reason}`);
  if (findings.length > MAX_LISTED) listed.push(`(+${findings.length - MAX_LISTED} more)`);
  const tips = [...new Set(findings.map((f) => f.suggestion).filter((s): s is string => !!s))];
  const text = [head, ...listed, ...(tips.length ? [`Safer: ${tips.join(" ")}`] : [])].join(" ");
  return text.length > MAX_REASON ? text.slice(0, MAX_REASON - 1) + "…" : text;
}

export function decide(verdict: Verdict, config: VetoConfig): GuardResult {
  const allowed: GuardResult = { decision: "allowed", because: [], stdout: "" };
  if (config.mode !== "guard" || verdict.verdict !== "flag") return allowed;
  let strongest: Action = "log";
  for (const f of verdict.findings) {
    const a = config.actions[f.severity];
    if (RANK[a] > RANK[strongest]) strongest = a;
  }
  if (strongest === "log") return allowed;
  const because = verdict.findings.filter((f) => config.actions[f.severity] === strongest);
  const reason = formatReason(strongest, because);
  const out: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    permissionDecision: strongest,
    permissionDecisionReason: reason,
  };
  // For "ask", the reason only reaches the user's prompt; tell Claude too (docs: additionalContext).
  if (strongest === "ask") out.additionalContext = reason;
  return { decision: strongest === "deny" ? "denied" : "asked", because, stdout: JSON.stringify({ hookSpecificOutput: out }) + "\n" };
}
