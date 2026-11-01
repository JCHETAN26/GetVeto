#!/usr/bin/env node
// Measures `veto hook` wall-clock latency (spawn -> exit, includes Node startup) over the REAL
// captured fixtures in test/fixtures/real/, cycling through all of them.
// Usage: node scripts/bench-hook.mjs [--runs N] [--cli path/to/cli.js]... [--only-pre] [--bash | --non-bash] [--guard] [--no-cache]
//   --cli        repeatable: several builds are run interleaved (one call each, in turn), so they
//                see the same machine load; one result line per build
//   --no-cache   VETO_NO_COMPILE_CACHE=1. Otherwise the compile cache (src/entry.cjs) goes to a temp
//                XDG_CACHE_HOME that the warm-up fills, never to ~/.cache
//   --only-pre   only PreToolUse fixtures (the events Veto analyzes)
//   --bash       only fixtures whose tool_name is Bash; --non-bash: everything else
//   --guard      run with .veto/config.json {"mode":"guard"} (default: no config = watch mode)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const runs = Number(opt("--runs", "200"));
const clis = args.flatMap((a, i) => (a === "--cli" ? [resolve(args[i + 1])] : []));
if (clis.length === 0) clis.push(join(repo, "dist", "cli.js"));
const noCache = args.includes("--no-cache");
const onlyPre = args.includes("--only-pre");
const bashOnly = args.includes("--bash");
const nonBash = args.includes("--non-bash");
const guard = args.includes("--guard");

const dir = join(repo, "test", "fixtures", "real");
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ name: f, raw: readFileSync(join(dir, f), "utf8") }))
  .filter((f) => {
    const e = JSON.parse(f.raw);
    if (onlyPre && e.hook_event_name !== "PreToolUse") return false;
    if (bashOnly && e.tool_name !== "Bash") return false;
    if (nonBash && (e.tool_name === "Bash" || e.tool_name === undefined)) return false;
    return true;
  });
if (fixtures.length === 0) throw new Error("no fixtures match the filters");

const root = mkdtempSync(join(tmpdir(), "veto-bench-"));
const cacheHome = mkdtempSync(join(tmpdir(), "veto-bench-cache-"));
if (guard) {
  mkdirSync(join(root, ".veto"), { mode: 0o700 });
  writeFileSync(join(root, ".veto", "config.json"), JSON.stringify({ mode: "guard" }));
}
const env = { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_CACHE_HOME: cacheHome };
delete env.NODE_COMPILE_CACHE;
if (noCache) env.VETO_NO_COMPILE_CACHE = "1";
const once = (cli, raw) =>
  new Promise((res, rej) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(process.execPath, [cli, "hook"], {
      cwd: root,
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    p.on("error", rej);
    p.on("exit", (code) => res({ code, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    p.stdin.end(raw);
  });

for (const cli of clis) for (const f of fixtures) await once(cli, f.raw); // warm caches
const ms = clis.map(() => []);
for (let i = 0; i < runs; i++) {
  for (let j = 0; j < clis.length; j++) {
    const r = await once(clis[j], fixtures[i % fixtures.length].raw);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    ms[j].push(r.ms);
  }
}
rmSync(root, { recursive: true, force: true });
rmSync(cacheHome, { recursive: true, force: true });
const what = `${runs} runs over ${fixtures.length} real fixtures${onlyPre ? " (PreToolUse)" : ""}${bashOnly ? " [Bash]" : nonBash ? " [non-Bash]" : ""}${guard ? " guard" : " watch"}${noCache ? " no-cache" : ""}`;
for (let j = 0; j < clis.length; j++) {
  const a = ms[j].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const label = clis.length > 1 ? ` ${clis[j]}` : "";
  console.log(
    `veto hook${label}: ${what}, ${process.version}, load ${loadavg()[0].toFixed(1)}: ` +
      `p50=${q(0.5).toFixed(1)}ms p95=${q(0.95).toFixed(1)}ms max=${a.at(-1).toFixed(1)}ms`,
  );
}
