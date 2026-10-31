import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..");
export const CLI = join(REPO, "dist", "cli.js");

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Spawn the BUILT CLI as a subprocess. `stdin: null` leaves stdin open (never closed). */
export function runCli(
  args: string[],
  opts: { cwd: string; stdin?: string | null; env?: Record<string, string | undefined>; killAfterMs?: number },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never inherit the CLAUDE_PROJECT_DIR of the session running these tests.
    delete env.CLAUDE_PROJECT_DIR;
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), opts.killAfterMs ?? 10000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolvePromise({ code, signal, stdout, stderr, ms });
    });
    if (opts.stdin === null) return; // leave open
    child.stdin.end(opts.stdin ?? "");
  });
}

export function tempProject(prefix = "veto-test-"): string {
  // realpath: macOS /tmp is a symlink; keeps path assertions simple.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface Fixture {
  name: string;
  source: "real" | "docs";
  raw: string;
  event: Record<string, unknown>;
}

/**
 * Integration payloads. Rule 1 (CLAUDE.md): real captures win; docs-verbatim examples are used
 * only while test/fixtures/real/ has no captured payloads.
 */
export function loadFixtures(): Fixture[] {
  const load = (dir: string, source: "real" | "docs") =>
    readdirSync(join(REPO, "test", "fixtures", dir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((name) => {
        const raw = readFileSync(join(REPO, "test", "fixtures", dir, name), "utf8");
        return { name, source, raw, event: JSON.parse(raw) as Record<string, unknown> };
      });
  const real = load("real", "real");
  return real.length > 0 ? real : load("docs", "docs");
}
