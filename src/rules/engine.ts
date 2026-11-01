// Rule engine: runs every registered rule over one PreToolUse event and returns a verdict.
// WATCH MODE: the verdict is recorded only. Nothing here decides whether the call proceeds.
// Never throws: any internal error becomes verdict "error" (the caller still allows).
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { SimpleCommand } from "../shell/parse.js";
import { rules as destructive } from "./destructive/index.js";
import { rules as exfiltration } from "./exfiltration/index.js";
import { rules as fileTools } from "./file-tools/index.js";
import { rules as secretAccess } from "./secret-access/index.js";
import { SEVERITY_RANK, type Finding, type GitStatus, type Rule, type RuleContext } from "./types.js";

export const RULES: readonly Rule[] = [...destructive, ...fileTools, ...secretAccess, ...exfiltration];

/** Registered category modules, in order. secret-access and exfiltration are empty placeholders. */
export const CATEGORIES = ["destructive", "file-tools", "secret-access", "exfiltration"] as const;

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
}

/** Short: only runs when a work-discarding git command is present, and must not stall the hook. */
export const GIT_STATUS_TIMEOUT_MS = 500;

/** `git status --porcelain` in dir. null on any failure (not a repo, timeout, no git). */
export function readGitStatus(dir: string): GitStatus | null {
  try {
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

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export async function evaluate(event: Record<string, unknown>, opts: EngineOptions): Promise<Verdict> {
  const start = performance.now();
  const ms = () => Math.round((performance.now() - start) * 1000) / 1000;
  try {
    const toolName = str(event.tool_name);
    const input = event.tool_input;
    const toolInput = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const home = opts.home ?? homedir();
    const evCwd = str(event.cwd);
    const cwd = evCwd && isAbsolute(evCwd) ? evCwd : null;

    let commands: SimpleCommand[] = [];
    let incomplete: string | undefined;
    if (toolName === "Bash") {
      const command = toolInput.command;
      if (typeof command === "string") {
        // Lazy: the parser is only loaded for Bash events.
        const { parseCommand } = await import("../shell/parse.js");
        const r = parseCommand(command, { cwd: cwd ?? undefined, home });
        if ("parseError" in r) incomplete = `command did not parse: ${r.parseError}`;
        else commands = r.commands;
      }
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
    for (const rule of opts.rules ?? RULES) findings.push(...rule.check(ctx));
    findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

    const v: Verdict = { verdict: findings.length > 0 ? "flag" : "allow", findings, analysis_ms: ms() };
    if (incomplete) v.incomplete = incomplete;
    return v;
  } catch (e) {
    return { verdict: "error", findings: [], analysis_ms: ms(), error: String((e as Error)?.message ?? e) };
  }
}
