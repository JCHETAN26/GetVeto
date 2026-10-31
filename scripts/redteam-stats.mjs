#!/usr/bin/env node
// npm run redteam:stats: counts of labeled examples in test/fixtures/redteam/ by verdict and
// category, with a warning for any category under 5 examples. Requires `npm run build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { computeStats, formatStats } = await import(join(repo, "dist", "label.js"));
const dir = process.argv[2] ? resolve(process.argv[2]) : join(repo, "test", "fixtures", "redteam");
if (!existsSync(dir)) {
  console.log(`No labeled examples yet (${dir} doesn't exist). Run \`veto label\` first.`);
  process.exit(0);
}
const examples = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((name) => {
    try {
      return { name, data: JSON.parse(readFileSync(join(dir, name), "utf8")) };
    } catch {
      return { name, data: null };
    }
  });
console.log(`Dataset: ${dir}\n`);
console.log(formatStats(computeStats(examples)));
