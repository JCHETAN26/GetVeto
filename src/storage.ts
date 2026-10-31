// Owner-only storage for everything under <project>/.veto/.
// Kept dependency-free and synchronous: it runs on the hook hot path.
import { closeSync, fchmodSync, mkdirSync, openSync, writeSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

export const VETO_DIR = ".veto";
export const LOG_FILE = "log.jsonl";
export const ERROR_FILE = "errors.log";

export function vetoDir(projectRoot: string): string {
  return join(projectRoot, VETO_DIR);
}

/**
 * Create <root>/.veto with mode 0700 (no-op if it exists).
 *
 * Deliberately NOT `mkdirSync(..., { recursive: true })`: on Node 22.14 that call never returns
 * for some paths (e.g. under /proc), which would hang the user's agent. The project root must
 * already exist; we only ever create one level.
 */
export function ensureVetoDir(projectRoot: string): string {
  const dir = vetoDir(projectRoot);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // mkdir's mode only applies on creation and is filtered by umask. Only ever *remove*
  // group/other bits; never loosen a directory the user locked down further.
  try {
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(dir, mode & 0o700);
  } catch {
    // Filesystems without POSIX permissions (e.g. exFAT) can't honor this. Not fatal.
  }
  return dir;
}

/** Append `text` to a file created/kept at mode 0600. One write call per append. */
export function appendPrivate(path: string, text: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // see ensureVetoDir
    }
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Write a whole file at mode 0600 (truncating). */
export function writePrivate(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // see ensureVetoDir
    }
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
