#!/usr/bin/env node
// Measures parseCommand (dist/shell/parse.js) per command:
//   cold  = fresh `node` process: dynamic import of the module + first parse (what a hook pays)
//   warm  = median of repeated parses in one process (parser cost alone)
// Commands: every real captured Bash command (test/fixtures/real) + everyday dev commands.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(repo, "dist", "shell", "parse.js");
const fx = join(repo, "test", "fixtures", "real");
const real = readdirSync(fx)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(fx, f), "utf8")))
  .filter((e) => e.hook_event_name === "PreToolUse" && e.tool_name === "Bash")
  .map((e) => e.tool_input.command);
const everyday = [
  "ls -la",
  "git status",
  "git log --oneline -5",
  "npm test",
  "npm run build",
  "cat src/index.js",
  "sed -i 's/a/b/' file.js && cat file.js && node file.js",
  "rm -rf node_modules && npm install",
  "FOO=1 npm test",
  'echo "$(git rev-parse HEAD)"',
  "cat > CHANGELOG.md <<EOF\n## $(date +%F)\n- fixed tests\nEOF",
];
const commands = [...new Set([...real, ...everyday])];

const { parseCommand } = await import(mod);
const rows = [];
for (const c of commands) {
  // cold: new process, import + first parse, timed inside the child (excludes Node startup)
  const colds = [];
  for (let i = 0; i < 5; i++) {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const t=performance.now();const m=await import(${JSON.stringify(mod)});const t1=performance.now();m.parseCommand(${JSON.stringify(c)});const t2=performance.now();console.log((t1-t).toFixed(3)+" "+(t2-t1).toFixed(3))`],
      { encoding: "utf8" },
    );
    colds.push(r.stdout.trim().split(" ").map(Number));
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (let i = 0; i < 200; i++) parseCommand(c); // warm up the JIT
  const warm = [];
  for (let i = 0; i < 500; i++) {
    const t = performance.now();
    parseCommand(c);
    warm.push(performance.now() - t);
  }
  rows.push({ c, imp: med(colds.map((x) => x[0])), first: med(colds.map((x) => x[1])), warm: med(warm) * 1000 });
}
console.log(`parseCommand timing (${process.version}); cold = median of 5 fresh processes, warm = median of 500`);
console.log(`${"import".padStart(8)} ${"1st parse".padStart(10)} ${"warm".padStart(9)}  command`);
for (const r of rows) {
  console.log(`${r.imp.toFixed(1).padStart(6)}ms ${r.first.toFixed(2).padStart(8)}ms ${r.warm.toFixed(1).padStart(6)}µs  ${JSON.stringify(r.c).slice(0, 70)}`);
}
