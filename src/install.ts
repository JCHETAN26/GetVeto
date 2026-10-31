// `veto init` and `veto uninstall`. Project-level only: never touches ~/.claude.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  addVetoHooks,
  containsVeto,
  gitignoreAppend,
  gitignoreHas,
  parseSettings,
  removeVetoHooks,
  serializeSettings,
} from "./settings.js";
import { ensureVetoDir, writePrivate } from "./storage.js";

export const LOCAL_SETTINGS = join(".claude", "settings.local.json");
export const SHARED_SETTINGS = join(".claude", "settings.json");
const STATE_FILE = "install-state.json";

interface InstallState {
  /** Settings files that did not exist before `veto init` created them (relative paths). */
  createdSettingsFiles: string[];
}

type Out = (line: string) => void;

function readState(root: string): InstallState {
  try {
    const v = JSON.parse(readFileSync(join(root, ".veto", STATE_FILE), "utf8")) as Partial<InstallState>;
    return { createdSettingsFiles: Array.isArray(v.createdSettingsFiles) ? v.createdSettingsFiles : [] };
  } catch {
    return { createdSettingsFiles: [] };
  }
}

function writeState(root: string, state: InstallState): void {
  const dir = ensureVetoDir(root);
  writePrivate(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copy an existing file into .veto/backups/ before we modify it. Returns the backup path. */
function backup(root: string, relPath: string): string {
  const dir = join(ensureVetoDir(root), "backups");
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const dest = join(dir, `${relPath.replace(/[\\/]/g, "__")}.${timestamp()}.bak`);
  copyFileSync(join(root, relPath), dest);
  return dest;
}

function readSettingsFile(root: string, relPath: string): Record<string, unknown> | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, "utf8");
  try {
    return parseSettings(text);
  } catch (e) {
    throw new Error(
      `${relPath} is not valid JSON (${(e as Error).message}). Veto will not modify it. Fix the file and re-run.`,
    );
  }
}

/** Find the nearest enclosing git root, or null. */
function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface InitOptions {
  shared: boolean;
}

export function init(root: string, opts: InitOptions, out: Out): number {
  const rel = opts.shared ? SHARED_SETTINGS : LOCAL_SETTINGS;
  const abs = join(root, rel);
  let changes = 0;

  const gitRoot = findGitRoot(root);
  if (gitRoot && gitRoot !== root) {
    out(
      `warning: ${root} is inside the git repository ${gitRoot}. Claude Code reads .claude/settings.local.json ` +
        `from the repository root when started in a subdirectory. Consider running \`veto init\` in ${gitRoot}.`,
    );
  }

  // 1. Settings file
  const existing = readSettingsFile(root, rel);
  const { settings, added } = addVetoHooks(existing ?? {});
  if (added.length === 0) {
    out(`unchanged: ${abs} already contains the Veto hook.`);
  } else {
    if (existing !== null) {
      const b = backup(root, rel);
      out(`backup:    ${abs} -> ${b}`);
    }
    if (!existsSync(dirname(abs))) mkdirSync(dirname(abs)); // .claude/ directly under root
    writeFileSync(abs, serializeSettings(settings));
    out(`${existing === null ? "created:" : "modified:"}  ${abs}`);
    out(`           added hook \`veto hook\` (matcher "*", timeout 10s) to: ${added.join(", ")}`);
    if (existing === null) {
      const state = readState(root);
      if (!state.createdSettingsFiles.includes(rel)) state.createdSettingsFiles.push(rel);
      writeState(root, state);
    }
    changes++;
  }

  // 2. .veto/ directory (0700)
  const vetoExisted = existsSync(join(root, ".veto"));
  ensureVetoDir(root);
  if (!vetoExisted) {
    out(`created:   ${join(root, ".veto")}/ (mode 0700; logs are written here)`);
    changes++;
  }

  // 3. .gitignore
  const giPath = join(root, ".gitignore");
  const giText = existsSync(giPath) ? readFileSync(giPath, "utf8") : null;
  const wanted = [".veto/"];
  // Claude Code only auto-ignores settings.local.json when *it* creates the file.
  if (!opts.shared) wanted.push(".claude/settings.local.json");
  const missing = wanted.filter((e) => giText === null || !gitignoreHas(giText, e));
  if (missing.length > 0) {
    writeFileSync(giPath, gitignoreAppend(giText ?? "", missing));
    out(`${giText === null ? "created:" : "modified:"}  ${giPath} (added: ${missing.join(", ")})`);
    changes++;
  } else {
    out(`unchanged: ${giPath} already ignores ${wanted.join(", ")}`);
  }

  if (opts.shared) {
    out(
      `note: ${rel} is meant to be committed. Teammates without Veto installed will see a ` +
        `"hook error" notice on each tool call (non-blocking).`,
    );
  }
  out(changes === 0 ? "Veto is already installed. Nothing changed." : "Veto installed (observe-only: nothing is blocked).");
  out("Restart Claude Code in this folder (or keep it running; it reloads settings) and accept the trust prompt.");
  return 0;
}

export function uninstall(root: string, out: Out): number {
  const state = readState(root);
  let any = false;
  for (const rel of [LOCAL_SETTINGS, SHARED_SETTINGS]) {
    const abs = join(root, rel);
    const existing = readSettingsFile(root, rel);
    if (existing === null || !containsVeto(existing)) continue;
    any = true;
    const b = backup(root, rel);
    out(`backup:    ${abs} -> ${b}`);
    const { settings, removed } = removeVetoHooks(existing);
    const summary = Object.entries(removed)
      .map(([ev, n]) => `${ev}${n > 1 ? ` x${n}` : ""}`)
      .join(", ");
    if (Object.keys(settings).length === 0 && state.createdSettingsFiles.includes(rel)) {
      rmSync(abs);
      out(`deleted:   ${abs} (Veto created it and it is now empty; removed: ${summary})`);
    } else {
      writeFileSync(abs, serializeSettings(settings));
      out(`modified:  ${abs} (removed Veto hook from: ${summary}; other settings untouched)`);
    }
    state.createdSettingsFiles = state.createdSettingsFiles.filter((f) => f !== rel);
  }
  if (!any) {
    out(`Veto hook not found in ${join(root, LOCAL_SETTINGS)} or ${join(root, SHARED_SETTINGS)}. Nothing changed.`);
    return 0;
  }
  if (existsSync(join(root, ".veto"))) writeState(root, state);
  out(`kept:      ${join(root, ".veto")}/ (your logs). Delete it yourself if you no longer want them.`);
  out(`kept:      .gitignore entries for .veto/ (harmless).`);
  return 0;
}
