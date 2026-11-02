// Pure merge logic for Claude Code settings files. No filesystem access here.
// Format reference: docs/hooks-research.md §4.

// UserPromptSubmit is logged so `veto label` can show which prompt led to a tool call
// (tool events carry prompt_id but not the prompt text).
export const VETO_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"] as const;

/** Events whose matcher filters on tool name. UserPromptSubmit has no matcher, so we omit it. */
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

function newGroup(event: string, handler: CommandHandler): Record<string, unknown> {
  return TOOL_EVENTS.has(event) ? { matcher: "*", hooks: [clone(handler)] } : { hooks: [clone(handler)] };
}

/** Seconds. Claude Code's default is 600; we cap a hung Veto at 10s. */
export const VETO_HOOK_TIMEOUT_S = 10;

export interface CommandHandler {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  [k: string]: unknown;
}

/** Where the hook runs from. Absent = portable form (`veto` resolved on PATH). */
export interface HookCommandSpec {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of Veto's dist/cli.js. */
  cli: string;
}

/**
 * The exact handler Veto installs. Exec form (no shell), so paths with spaces are safe.
 * - With `spec`: `<node> <cli> hook`, which works when Claude Code is launched without the
 *   user's shell PATH (desktop app, IDE).
 * - Without: `veto hook` on PATH, which is portable across machines (used for --shared).
 */
export function vetoHandler(spec?: HookCommandSpec): CommandHandler {
  if (spec) return { type: "command", command: spec.node, args: [spec.cli, "hook"], timeout: VETO_HOOK_TIMEOUT_S };
  return { type: "command", command: "veto", args: ["hook"], timeout: VETO_HOOK_TIMEOUT_S };
}

/** Is `p` the path of a Veto CLI entry point? Pure default: `.../getveto/dist/cli.js` (any case). */
export type VetoCliPredicate = (p: string) => boolean;
export const looksLikeVetoCliPath: VetoCliPredicate = (p) => /(^|[\\/])getveto[\\/]dist[\\/]cli\.js$/i.test(p);

/**
 * Recognizes every form Veto has written (and a hand-written shell form):
 *   {command:"veto", args:["hook", ...]}            portable form (Task #1, --shared)
 *   {command:"<node>", args:["<.../cli.js>", "hook"]}   absolute form (Task #2)
 *   {command:"veto hook"}                           hand-written shell form
 */
export function isVetoHandler(h: unknown, isVetoCli: VetoCliPredicate = looksLikeVetoCliPath): boolean {
  if (!isPlainObject(h)) return false;
  if (h.type !== "command") return false;
  const args = h.args;
  if (h.command === "veto" && Array.isArray(args) && args[0] === "hook") return true;
  if (
    typeof h.command === "string" &&
    Array.isArray(args) &&
    args.length === 2 &&
    args[1] === "hook" &&
    typeof args[0] === "string" &&
    isVetoCli(args[0])
  ) {
    return true;
  }
  // Also recognize a shell-form spelling someone may have written by hand.
  return typeof h.command === "string" && /^\s*veto\s+hook\s*$/.test(h.command) && args === undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class SettingsShapeError extends Error {}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface MergeResult {
  settings: Record<string, unknown>;
  /** Events Veto was newly added to. */
  added: string[];
  /** Events whose existing Veto entry was replaced in place with the desired one. */
  upgraded: string[];
}

/**
 * Make each Veto event carry exactly one Veto handler equal to `desired`.
 * - none present: append a `"*"` matcher group
 * - present but different (e.g. old relative `veto hook`): replace it IN PLACE, and drop any
 *   extra Veto duplicates in that event
 * - present and identical: no change (idempotent)
 * Never touches non-Veto handlers.
 */
export function addVetoHooks(
  input: Record<string, unknown>,
  desired: CommandHandler = vetoHandler(),
  isVetoCli: VetoCliPredicate = looksLikeVetoCliPath,
): MergeResult {
  const settings = clone(input);
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new SettingsShapeError(`"hooks" must be an object, found ${typeof settings.hooks}`);
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  const upgraded: string[] = [];
  const isVeto = (h: unknown) => isVetoHandler(h, isVetoCli);

  for (const event of VETO_EVENTS) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new SettingsShapeError(`"hooks.${event}" must be an array`);
    }
    const list = (groups ?? []) as unknown[];
    const found: { g: number; h: number }[] = [];
    list.forEach((g, gi) => {
      if (isPlainObject(g) && Array.isArray(g.hooks)) {
        g.hooks.forEach((h, hi) => {
          if (isVeto(h)) found.push({ g: gi, h: hi });
        });
      }
    });

    if (found.length === 0) {
      list.push(newGroup(event, desired));
      hooks[event] = list;
      added.push(event);
      continue;
    }
    const first = found[0]!;
    const firstGroup = list[first.g] as { hooks: unknown[] };
    if (found.length === 1 && sameJson(firstGroup.hooks[first.h], desired)) continue;

    // Upgrade in place: keep the first Veto entry's position, drop other Veto duplicates.
    firstGroup.hooks[first.h] = clone(desired);
    const emptiedByUs = new Set<number>();
    for (const loc of found.slice(1).reverse()) {
      const grp = list[loc.g] as { hooks: unknown[] };
      grp.hooks.splice(loc.h, 1);
      if (grp.hooks.length === 0) emptiedByUs.add(loc.g);
    }
    hooks[event] = list.filter((_g, gi) => !emptiedByUs.has(gi));
    upgraded.push(event);
  }

  if (added.length > 0 || upgraded.length > 0) settings.hooks = hooks;
  return { settings, added, upgraded };
}

export interface RemoveResult {
  settings: Record<string, unknown>;
  /** Number of Veto handlers removed, per event. */
  removed: Record<string, number>;
  changed: boolean;
}

/**
 * Remove every Veto handler (any event). Matcher groups / event arrays / the hooks object are
 * deleted only if Veto's removal left them empty. Everything else is left exactly as found.
 */
export function removeVetoHooks(
  input: Record<string, unknown>,
  isVetoCli: VetoCliPredicate = looksLikeVetoCliPath,
): RemoveResult {
  const settings = clone(input);
  const removed: Record<string, number> = {};
  if (!isPlainObject(settings.hooks)) return { settings, removed, changed: false };
  const hooks = settings.hooks;

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let count = 0;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const before = g.hooks.length;
      const remaining = g.hooks.filter((h) => !isVetoHandler(h, isVetoCli));
      const n = before - remaining.length;
      if (n === 0) {
        kept.push(g);
        continue;
      }
      count += n;
      if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
      // else: the group only held Veto handlers -> drop it.
    }
    if (count > 0) {
      removed[event] = count;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }

  const changed = Object.keys(removed).length > 0;
  if (changed && Object.keys(hooks).length === 0) delete settings.hooks;
  return { settings, removed, changed };
}

export function containsVeto(settings: Record<string, unknown>, isVetoCli: VetoCliPredicate = looksLikeVetoCliPath): boolean {
  return removeVetoHooks(settings, isVetoCli).changed;
}

/** The Veto PreToolUse handlers installed in a settings object (for `veto doctor`). */
export function vetoHandlersIn(settings: Record<string, unknown>, isVetoCli: VetoCliPredicate = looksLikeVetoCliPath): CommandHandler[] {
  const out: CommandHandler[] = [];
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  for (const g of groups) {
    const list = isPlainObject(g) && Array.isArray(g.hooks) ? g.hooks : [];
    for (const h of list) if (isVetoHandler(h, isVetoCli) && isPlainObject(h)) out.push(h as CommandHandler);
  }
  return out;
}

export function serializeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Parse a settings file's text. Empty/whitespace file is treated as {}. */
export function parseSettings(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const v = JSON.parse(text) as unknown;
  if (!isPlainObject(v)) throw new SettingsShapeError("settings file must contain a JSON object");
  return v;
}

/** True if a .gitignore already ignores `entry` (simple line match, ignores comments). */
export function gitignoreHas(text: string, entry: string): boolean {
  const norm = (s: string) => s.trim().replace(/^\//, "").replace(/\/$/, "");
  const want = norm(entry);
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .some((l) => norm(l) === want);
}

export function gitignoreAppend(text: string, entries: string[]): string {
  let out = text;
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  for (const e of entries) out += e + "\n";
  return out;
}
