// Rule engine: runs every registered rule over one PreToolUse event and returns a verdict.
// WATCH MODE: the verdict is recorded only. Nothing here decides whether the call proceeds.
// Never throws: any internal error becomes verdict "error" (the caller still allows).
//
// Startup cost matters (the hook is a fresh process per tool call), so category modules are
// loaded only for the tools they apply to, the shell parser only for Bash, and child_process
// only when a git check actually runs.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { nowMs } from "../clock.js";
import type { SimpleCommand } from "../shell/parse.js";
import type { Category, Finding, GitStatus, Rule, RuleContext } from "./types.js";

// Local copy of types.ts SEVERITY_RANK so tools without rules load no rule modules at all.
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const;
const FILE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"];

interface CategoryModule {
  category: Category;
  /** Tools whose events this category's rules look at. */
  tools: readonly string[];
  load(): Promise<readonly Rule[]>;
}

/** Registered category modules, in order. secret-access and exfiltration are empty placeholders. */
export const CATEGORY_MODULES: readonly CategoryModule[] = [
  { category: "destructive", tools: ["Bash"], load: async () => (await import("./destructive/index.js")).rules },
  { category: "file-tools", tools: FILE_TOOLS, load: async () => (await import("./file-tools/index.js")).rules },
  // TODO(founder): widen `tools` when the founder-authored rules for these categories land.
  { category: "secret-access", tools: ["Bash"], load: async () => (await import("./secret-access/index.js")).rules },
  { category: "exfiltration", tools: ["Bash"], load: async () => (await import("./exfiltration/index.js")).rules },
  { category: "self-protection", tools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"], load: async () => (await import("./self-protection/index.js")).rules },
];

export const CATEGORIES = CATEGORY_MODULES.map((m) => m.category);

/** Every rule in every category (tests and tooling). */
export async function allRules(): Promise<Rule[]> {
  return (await Promise.all(CATEGORY_MODULES.map((m) => m.load()))).flat();
}

/** The rules that apply to one tool. */
export async function rulesFor(toolName: string | undefined): Promise<Rule[]> {
  if (!toolName) return [];
  const mods = CATEGORY_MODULES.filter((m) => m.tools.includes(toolName));
  return (await Promise.all(mods.map((m) => m.load()))).flat();
}

export interface Verdict {
  verdict: "allow" | "flag" | "error";
  /** Most severe first. */
  findings: Finding[];
  analysis_ms: number;
  /** verdict "error": what went wrong. */
  error?: string;
  /** The analysis was partial (e.g. the shell command didn't parse); rules saw no commands. */
  incomplete?: string;
}

export interface EngineOptions {
  projectRoot: string;
  home?: string;
  /** Override the rule list (tests). */
  rules?: readonly Rule[];
  /** Rule ids to skip (config disabledRules). */
  disabledRules?: readonly string[];
}

/** Short: only runs when a work-discarding git command is present, and must not stall the hook. */
export const GIT_STATUS_TIMEOUT_MS = 500;

/** `git status --porcelain` in dir. null on any failure (not a repo, timeout, no git). */
export function readGitStatus(dir: string): GitStatus | null {
  try {
    const { execFileSync } = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(
      "git",
      // Read-only: no optional index lock, and never run a repo-configured fsmonitor hook.
      ["-c", "core.fsmonitor=false", "-C", dir, "status", "--porcelain"],
      {
        encoding: "utf8",
        timeout: GIT_STATUS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    return {
      tracked: lines.some((l) => !l.startsWith("??")),
      untracked: lines.some((l) => l.startsWith("??")),
    };
  } catch {
    return null;
  }
}

/**
 * Could `command` run a program named one of `words`? Conservative: removes what bash removes
 * while forming a word (backslash-newline, backslashes, quote characters) and looks for any of
 * them as a whole word. ANSI-C quoting ($'\x72m') can spell anything, so it always says yes.
 * A trigger made only of punctuation (e.g. "<" for input redirection) matches anywhere.
 */
export function mayMention(command: string, words: readonly string[]): boolean {
  if (command.includes("$'")) return true;
  const plain = command.replace(/\\\n/g, "").replace(/[\\'"]/g, "");
  const isName = (w: string) => /[A-Za-z0-9]/.test(w);
  if (words.some((w) => !isName(w) && plain.includes(w))) return true;
  const names = words.filter(isName);
  if (names.length === 0) return false;
  const alt = names.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|[^A-Za-z0-9_-])(${alt})($|[^A-Za-z0-9_-])`).test(plain);
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export async function evaluate(event: Record<string, unknown>, opts: EngineOptions): Promise<Verdict> {
  const start = nowMs();
  const ms = () => Math.round((nowMs() - start) * 1000) / 1000;
  try {
    const toolName = str(event.tool_name);
    const input = event.tool_input;
    const toolInput = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const home = opts.home ?? homedir();
    const evCwd = str(event.cwd);
    const cwd = evCwd && isAbsolute(evCwd) ? evCwd : null;

    const disabled = new Set(opts.disabledRules ?? []);
    const rules = (opts.rules ?? (await rulesFor(toolName))).filter((r) => !disabled.has(r.id));
    let commands: SimpleCommand[] = [];
    let incomplete: string | undefined;
    const command = toolInput.command;
    // Parse only if some rule could match: one without triggers, or a trigger word appears.
    const needsParse =
      toolName === "Bash" &&
      typeof command === "string" &&
      rules.length > 0 &&
      (rules.some((r) => !r.triggers) || mayMention(command, rules.flatMap((r) => r.triggers ?? [])));
    if (needsParse && typeof command === "string") {
      // Lazy: the parser is only loaded for Bash events that need it.
      const { parseCommand } = await import("../shell/parse.js");
      const r = parseCommand(command, { cwd: cwd ?? undefined, home });
      if ("parseError" in r) incomplete = `command did not parse: ${r.parseError}`;
      else commands = r.commands;
    }

    const gitCache = new Map<string, GitStatus | null>();
    const ctx: RuleContext = {
      event,
      toolName,
      toolInput,
      projectRoot: opts.projectRoot,
      home,
      cwd,
      commands,
      gitStatus(dir) {
        if (!gitCache.has(dir)) gitCache.set(dir, readGitStatus(dir));
        return gitCache.get(dir) ?? null;
      },
    };

    const findings: Finding[] = [];
    for (const rule of rules) findings.push(...rule.check(ctx));
    findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

    const v: Verdict = { verdict: findings.length > 0 ? "flag" : "allow", findings, analysis_ms: ms() };
    if (incomplete) v.incomplete = incomplete;
    return v;
  } catch (e) {
    return { verdict: "error", findings: [], analysis_ms: ms(), error: String((e as Error)?.message ?? e) };
  }
}
