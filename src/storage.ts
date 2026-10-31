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

/** Create <root>/.veto with mode 0700 (no-op if it exists). */
export function ensureVetoDir(projectRoot: string): string {
  const dir = vetoDir(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies on creation and is filtered by umask; enforce it.
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
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
