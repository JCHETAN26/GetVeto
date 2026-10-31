// Safety logic for redteam/setup.mjs. Pure-ish (fs only), no side effects at import time.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SANDBOX_MARKER = ".veto-redteam-sandbox";
export const REMOTE_MARKER = "veto-redteam-remote.marker";
export const MARKER_TOKEN = "veto-redteam: created by GetVeto redteam/setup.mjs; disposable";

export class SetupError extends Error {}

/**
 * Top-level names a template may not write into: .git (a planted hook would run on the next
 * git command), .claude and .veto (would change or disable Veto's own install), the marker.
 */
export const PROTECTED_TOP = new Set([".git", ".claude", ".veto", SANDBOX_MARKER]);

/** True if `child` is `parent` or inside it (both absolute). */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Reject target paths that could hurt: the filesystem root, the home directory itself,
 * anything containing the Veto repo, and non-absolute paths.
 */
export function validateTarget(target, { home, repo, label }) {
  if (!isAbsolute(target)) throw new SetupError(`${label} path must be absolute: ${target}`);
  const t = resolve(target);
  if (t === sep || t === resolve(home)) throw new SetupError(`refusing to use ${t} as the ${label} path`);
  if (isInside(t, resolve(repo))) throw new SetupError(`${label} path ${t} contains the Veto repo; refusing`);
  return t;
}

/**
 * Decide what to do with an existing target.
 * Returns "create" (absent) or "reset" (present, ours, --reset given). Throws otherwise.
 */
export function planTarget(target, { reset, marker, label }) {
  if (!existsSync(target) && !isBrokenSymlink(target)) return "create";
  const st = lstatSync(target);
  if (st.isSymbolicLink()) throw new SetupError(`${label} ${target} is a symlink; refusing to touch it`);
  if (!st.isDirectory()) throw new SetupError(`${label} ${target} exists and is not a directory; refusing`);
  if (realpathSync(target) !== target) {
    throw new SetupError(`${label} ${target} resolves to ${realpathSync(target)}; refusing`);
  }
  if (!reset) throw new SetupError(`${label} ${target} already exists. Re-run with --reset to rebuild it.`);
  let content;
  try {
    content = readFileSync(join(target, marker), "utf8");
  } catch {
    throw new SetupError(`${label} ${target} has no ${marker} marker, so this script didn't create it. Refusing to delete.`);
  }
  if (!content.includes(MARKER_TOKEN)) {
    throw new SetupError(`${join(target, marker)} doesn't contain our marker token. Refusing to delete ${target}.`);
  }
  return "reset";
}

function isBrokenSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Delete a target that planTarget() approved for reset. Re-checks right before deleting. */
export function removeApproved(target, opts) {
  if (planTarget(target, { ...opts, reset: true }) !== "reset") return;
  rmSync(target, { recursive: true, force: true });
}

/**
 * List files under a templates folder as { rel (destination, relative to destRoot), abs }, refusing
 * symlinks and anything whose destination would land outside `destRoot`. README.md at the
 * templates root is skipped (it documents the folder); README.sandbox.md maps to README.md.
 */
export function listTemplateFiles(templatesDir, destRoot) {
  const out = [];
  if (!existsSync(templatesDir)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(templatesDir, abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new SetupError(`template ${rel} is a symlink; refusing`);
      // The folder's own README documents it; README.sandbox.md becomes the sandbox's README.md.
      const destRel = rel === "README.sandbox.md" ? "README.md" : rel;
      const dest = resolve(destRoot, destRel);
      if (!isInside(destRoot, dest) || dest === destRoot) {
        throw new SetupError(`template ${rel} would be written outside the sandbox; refusing`);
      }
      const top = destRel.split(/[\\/]/)[0];
      if (PROTECTED_TOP.has(top)) {
        throw new SetupError(`template ${rel} targets ${top}, which the generator manages; refusing`);
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        if (rel === "README.md") continue;
        out.push({ rel: destRel, abs });
      } else throw new SetupError(`template ${rel} is not a regular file; refusing`);
    }
  };
  walk(templatesDir);
  return out;
}
