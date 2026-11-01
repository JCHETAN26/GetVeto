// .veto/config.json: mode (watch | guard), what guard mode does per severity, disabled rules.
// Read on the hook hot path, so it is small, synchronous and dependency-free. An invalid file
// never breaks anything: the caller falls back to watch mode and logs the error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VETO_DIR, writePrivate } from "./storage.js";

export const CONFIG_FILE = "config.json";
export const MODES = ["watch", "guard"] as const;
export const ACTIONS = ["deny", "ask", "log"] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;

export type Mode = (typeof MODES)[number];
/** What guard mode does with a finding: deny the call, ask the user, or only log it. */
export type Action = (typeof ACTIONS)[number];
export type SeverityName = (typeof SEVERITIES)[number];

export interface VetoConfig {
  mode: Mode;
  actions: Record<SeverityName, Action>;
  disabledRules: string[];
}

/** Defaults: watch mode; in guard mode high → deny, medium → ask, low → log. A fresh object each call. */
export const defaultConfig = (): VetoConfig => ({ mode: "watch", actions: { high: "deny", medium: "ask", low: "log" }, disabledRules: [] });

export const configPath = (root: string) => join(root, VETO_DIR, CONFIG_FILE);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate parsed JSON. Missing fields take defaults; unknown keys and bad values are errors. */
export function validateConfig(raw: unknown): { config: VetoConfig } | { error: string } {
  if (!isObj(raw)) return { error: "config must be a JSON object" };
  const unknown = Object.keys(raw).filter((k) => !["mode", "actions", "disabledRules"].includes(k));
  if (unknown.length) return { error: `unknown key(s): ${unknown.join(", ")} (allowed: mode, actions, disabledRules)` };
  const config = defaultConfig();
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode as Mode)) return { error: `mode must be "watch" or "guard", got ${JSON.stringify(raw.mode)}` };
    config.mode = raw.mode as Mode;
  }
  if (raw.actions !== undefined) {
    if (!isObj(raw.actions)) return { error: "actions must be an object like {\"high\": \"deny\", \"medium\": \"ask\", \"low\": \"log\"}" };
    for (const [sev, act] of Object.entries(raw.actions)) {
      if (!SEVERITIES.includes(sev as SeverityName)) return { error: `actions: unknown severity ${JSON.stringify(sev)} (use high, medium, low)` };
      if (!ACTIONS.includes(act as Action)) return { error: `actions.${sev} must be "deny", "ask" or "log", got ${JSON.stringify(act)}` };
      config.actions[sev as SeverityName] = act as Action;
    }
  }
  if (raw.disabledRules !== undefined) {
    if (!Array.isArray(raw.disabledRules) || !raw.disabledRules.every((r) => typeof r === "string" && r.trim() !== "")) {
      return { error: "disabledRules must be a list of rule ids (strings)" };
    }
    config.disabledRules = [...new Set(raw.disabledRules as string[])];
  }
  return { config };
}

export interface LoadedConfig {
  config: VetoConfig;
  /** "file": read from .veto/config.json; "default": no file; "invalid": file rejected, watch mode. */
  source: "file" | "default" | "invalid";
  error?: string;
}

/** Never throws. An invalid or unreadable file gives watch mode plus an error to log. */
export function loadConfig(root: string): LoadedConfig {
  const path = configPath(root);
  try {
    if (!existsSync(path)) return { config: defaultConfig(), source: "default" };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return { config: defaultConfig(), source: "invalid", error: `${path}: invalid JSON: ${(e as Error).message}` };
    }
    const v = validateConfig(raw);
    if ("error" in v) return { config: defaultConfig(), source: "invalid", error: `${path}: ${v.error}` };
    return { config: v.config, source: "file" };
  } catch (e) {
    return { config: defaultConfig(), source: "invalid", error: `${path}: ${(e as Error).message}` };
  }
}

export function serializeConfig(c: VetoConfig): string {
  return JSON.stringify({ mode: c.mode, actions: c.actions, disabledRules: c.disabledRules }, null, 2) + "\n";
}

/** Write the config (mode 0600). The .veto directory must exist. */
export function saveConfig(root: string, c: VetoConfig): void {
  writePrivate(configPath(root), serializeConfig(c));
}
