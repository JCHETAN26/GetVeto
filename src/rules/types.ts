// Shared types for the rule engine. Type-only imports from shell/parse keep the parser out of
// the module graph until the engine loads it for a Bash event.
import type { SimpleCommand } from "../shell/parse.js";

export type Severity = "low" | "medium" | "high";
export type Category = "destructive" | "file-tools" | "secret-access" | "exfiltration";

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  /** One short human-readable sentence. */
  reason: string;
}

/** Answers "does this git work tree have changes a discard would lose?" null = couldn't tell. */
export interface GitStatus {
  /** Modified, staged or deleted tracked files. */
  tracked: boolean;
  /** Untracked files (what `git clean` removes). */
  untracked: boolean;
}

export interface RuleContext {
  event: Record<string, unknown>;
  toolName: string | undefined;
  toolInput: Record<string, unknown>;
  /** Where the project lives (CLAUDE_PROJECT_DIR, else the event's cwd). */
  projectRoot: string;
  home: string;
  /** The event's cwd: where Claude's shell is right now. null if the event has none. */
  cwd: string | null;
  /** Bash only: the parsed commands; [] for other tools or when the command didn't parse. */
  commands: SimpleCommand[];
  /** Runs `git status --porcelain` in dir (cached, short timeout). null on any failure. */
  gitStatus(dir: string): GitStatus | null;
}

export interface Rule {
  id: string;
  category: Category;
  check(ctx: RuleContext): Finding[];
}

/** One level lower, for a match we couldn't fully resolve. */
export function lower(s: Severity): Severity {
  return s === "high" ? "medium" : "low";
}

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
