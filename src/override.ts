// One-time overrides: `veto allow --once` (run by the user, in their own terminal) lets the next
// tool call whose blocking findings all match the most recent denial go ahead, within 10 minutes,
// and only in the project it was made in. The hook consumes it (deletes the file) on first use.
// Read on the hook hot path only when guard mode is about to deny or ask.
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding } from "./rules/types.js";
import { VETO_DIR } from "./storage.js";

export const OVERRIDE_FILE = "override.json";
export const ONCE_TTL_MS = 10 * 60 * 1000;

export interface FindingKey {
  ruleId: string;
  reason: string;
}

export interface OnceOverride {
  kind: "once";
  /** Absolute project root it was made in; it applies nowhere else. */
  project: string;
  created: string;
  expires: string;
  /** The denied call it was made from. */
  denied: { ts: string; tool: string | null; summary: string };
  /** The findings that denied it. A later call matches when its blocking findings are among these. */
  findings: FindingKey[];
}

export const overridePath = (root: string) => join(root, VETO_DIR, OVERRIDE_FILE);

const isKey = (v: unknown): v is FindingKey => !!v && typeof (v as FindingKey).ruleId === "string" && typeof (v as FindingKey).reason === "string";

/** The pending override, whatever its state. null if there is none or it's unreadable. */
export function readOverrideFile(root: string): OnceOverride | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(overridePath(root), "utf8"));
  } catch {
    return null;
  }
  const o = raw as OnceOverride;
  if (!o || o.kind !== "once" || typeof o.project !== "string" || typeof o.expires !== "string" || !Array.isArray(o.findings) || !o.findings.every(isKey)) return null;
  return o;
}

/** The override if it is usable now in this project: not expired, made here. */
export function activeOnce(root: string, now: Date): OnceOverride | null {
  const o = readOverrideFile(root);
  if (!o || resolve(o.project) !== resolve(root)) return null;
  const exp = Date.parse(o.expires);
  return Number.isFinite(exp) && now.getTime() <= exp ? o : null;
}

export const covers = (o: OnceOverride, f: Finding) => o.findings.some((k) => k.ruleId === f.ruleId && k.reason === f.reason);

/**
 * Use it up. Deleting the file is the claim: when two hook calls race, only one unlink succeeds,
 * so an override is never used twice.
 */
export function claimOnce(root: string): boolean {
  try {
    unlinkSync(overridePath(root));
    return true;
  } catch {
    return false;
  }
}
