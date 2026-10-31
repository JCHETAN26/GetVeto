// Non-interactive core of `veto label`: turn a project's .veto/log.jsonl into labeling
// candidates, build labeled examples, and summarize a labeled dataset. No terminal I/O here.
import { parseLog, summarizeInput } from "./logview.js";
import { redactEvent, type RedactEventOptions } from "./redact.js";

export const VERDICTS = ["allow", "flag"] as const;
export const CATEGORIES = ["benign", "destructive", "secret-access", "exfiltration", "injection-driven", "other"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Category = (typeof CATEGORIES)[number];

/**
 * What happened after the PreToolUse event:
 *  - "ran":    a PostToolUse with the same tool_use_id was logged
 *  - "failed": a PostToolUseFailure with the same tool_use_id was logged
 *  - "no-post": neither, which means denied at the permission prompt, blocked, interrupted,
 *    or the session ended first (docs: PostToolUseFailure doesn't fire for permission denials)
 */
export type Outcome = "ran" | "failed" | "no-post";

export interface Candidate {
  id: string;
  loggedAt: string;
  event: Record<string, unknown>;
  toolName: string;
  /** Full command (Bash/PowerShell), file path, URL, etc. Not truncated. */
  detail: string;
  /** Text of the prompt with the same prompt_id, if a UserPromptSubmit was logged. */
  prompt: string | null;
  outcome: Outcome;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Stable, filename-safe id. tool_use_id is unique per call; fall back to session + timestamp. */
export function candidateId(event: Record<string, unknown>, loggedAt: string): string {
  const raw = str(event.tool_use_id) ?? `${str(event.session_id) ?? "nosession"}-${loggedAt}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

/** The full, untruncated thing a human needs to judge the call. */
export function candidateDetail(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;
    if ((toolName === "Bash" || toolName === "PowerShell") && typeof i.command === "string") return i.command;
    for (const k of ["file_path", "notebook_path", "url", "query", "pattern"]) {
      if (typeof i[k] === "string") return i[k] as string;
    }
  }
  return summarizeInput(toolName, input);
}

/** All PreToolUse events in log order, joined with their prompt and outcome. */
export function loadCandidates(logText: string): Candidate[] {
  const { entries } = parseLog(logText);
  const prompts = new Map<string, string>();
  const outcomes = new Map<string, Outcome>();
  for (const { event } of entries) {
    const name = event.hook_event_name;
    if (name === "UserPromptSubmit" && typeof event.prompt_id === "string" && typeof event.prompt === "string") {
      prompts.set(event.prompt_id, event.prompt);
    }
    const tid = str(event.tool_use_id);
    if (tid && name === "PostToolUse") outcomes.set(tid, "ran");
    if (tid && name === "PostToolUseFailure") outcomes.set(tid, "failed");
  }
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const { ts, event } of entries) {
    if (event.hook_event_name !== "PreToolUse") continue;
    const id = candidateId(event, ts);
    if (seen.has(id)) continue; // a duplicate log line must not become two examples
    seen.add(id);
    const toolName = str(event.tool_name) ?? "?";
    const tid = str(event.tool_use_id);
    out.push({
      id,
      loggedAt: ts,
      event,
      toolName,
      detail: candidateDetail(toolName, event.tool_input),
      prompt: (str(event.prompt_id) && prompts.get(event.prompt_id as string)) || null,
      outcome: (tid && outcomes.get(tid)) || "no-post",
    });
  }
  return out;
}

export function pendingCandidates(all: Candidate[], labeledIds: ReadonlySet<string>): Candidate[] {
  return all.filter((c) => !labeledIds.has(c.id));
}

/** Playbook prompts by scenario number, parsed from "### N. title" + "- **Prompt:** `...`". */
export function parsePlaybook(markdown: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /^### (\d+)\.[^\n]*\n(?:(?!### )[^\n]*\n)*?- \*\*Prompt:\*\* `([^`]+)`/gm;
  for (const m of markdown.matchAll(re)) map.set(Number(m[1]), m[2]!);
  return map;
}

/** Scenario number whose playbook prompt equals this prompt (whitespace-insensitive), if any. */
export function suggestScenario(prompt: string | null, playbook: Map<number, string>): number | null {
  if (!prompt) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const p = norm(prompt);
  for (const [n, text] of playbook) if (norm(text) === p) return n;
  return null;
}

export interface Label {
  verdict: Verdict;
  category: Category;
  note: string;
  scenario: number | null;
}

export interface LabeledExample {
  id: string;
  verdict: Verdict;
  category: Category;
  note: string;
  scenario: number | null;
  labeled_at: string;
  logged_at: string;
  outcome: Outcome;
  /** Redacted text of the prompt that led to this call, if it was logged. */
  prompt: string | null;
  /** The original real PreToolUse event, redacted the same way capture-fixtures does. */
  event: unknown;
}

export function validateLabel(l: Label): void {
  if (!VERDICTS.includes(l.verdict)) throw new Error(`invalid verdict: ${l.verdict}`);
  if (!CATEGORIES.includes(l.category)) throw new Error(`invalid category: ${l.category}`);
  if (l.scenario !== null && (!Number.isInteger(l.scenario) || l.scenario <= 0)) {
    throw new Error(`invalid scenario number: ${l.scenario}`);
  }
  if (/[\r\n]/.test(l.note)) throw new Error("note must be one line");
}

export function buildExample(c: Candidate, label: Label, redact: RedactEventOptions, now: Date): LabeledExample {
  validateLabel(label);
  return {
    id: c.id,
    verdict: label.verdict,
    category: label.category,
    note: label.note.trim(),
    scenario: label.scenario,
    labeled_at: now.toISOString(),
    logged_at: c.loggedAt,
    outcome: c.outcome,
    prompt: c.prompt === null ? null : (redactEvent(c.prompt, redact).value as string),
    event: redactEvent(c.event, redact).value,
  };
}

// ---------- dataset summary (npm run redteam:stats) ----------

export const MIN_PER_CATEGORY = 5;

export interface Stats {
  total: number;
  byVerdict: Record<string, number>;
  byCategory: Record<string, number>;
  byCategoryVerdict: Record<string, Record<string, number>>;
  /** Categories (all known ones, plus any unknown found) with fewer than MIN_PER_CATEGORY examples. */
  thin: { category: string; count: number }[];
  invalid: string[];
}

export function computeStats(examples: { name: string; data: unknown }[]): Stats {
  const byVerdict: Record<string, number> = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const byCategory: Record<string, number> = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const byCategoryVerdict: Record<string, Record<string, number>> = {};
  const invalid: string[] = [];
  let total = 0;
  for (const { name, data } of examples) {
    const d = data as Partial<LabeledExample> | null;
    if (!d || typeof d.verdict !== "string" || typeof d.category !== "string") {
      invalid.push(name);
      continue;
    }
    total++;
    byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1;
    byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
    const row = (byCategoryVerdict[d.category] ??= {});
    row[d.verdict] = (row[d.verdict] ?? 0) + 1;
  }
  const thin = Object.entries(byCategory)
    .filter(([, n]) => n < MIN_PER_CATEGORY)
    .map(([category, count]) => ({ category, count }));
  return { total, byVerdict, byCategory, byCategoryVerdict, thin, invalid };
}

export function formatStats(s: Stats): string {
  const lines: string[] = [];
  lines.push(`Labeled examples: ${s.total}`);
  lines.push("");
  lines.push("By verdict:");
  for (const [v, n] of Object.entries(s.byVerdict)) lines.push(`  ${v.padEnd(18)} ${String(n).padStart(4)}`);
  lines.push("");
  lines.push(`By category:               allow  flag`);
  for (const [c, n] of Object.entries(s.byCategory)) {
    const row = s.byCategoryVerdict[c] ?? {};
    lines.push(`  ${c.padEnd(18)} ${String(n).padStart(4)}   ${String(row.allow ?? 0).padStart(4)}  ${String(row.flag ?? 0).padStart(4)}`);
  }
  if (s.thin.length) {
    lines.push("");
    for (const t of s.thin) {
      lines.push(`WARNING: category "${t.category}" has only ${t.count} example(s); aim for at least ${MIN_PER_CATEGORY}.`);
    }
  }
  if (s.invalid.length) {
    lines.push("");
    lines.push(`WARNING: ${s.invalid.length} file(s) are not valid labeled examples: ${s.invalid.join(", ")}`);
  }
  return lines.join("\n");
}
