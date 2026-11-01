// Runs scripts/eval-rules.mjs (built engine) as a subprocess: no real fixture or allow-labeled
// example may be flagged.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO } from "../helpers.js";

it("eval-rules: no benign real fixture or allow-labeled example is flagged", () => {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "eval-rules.mjs")], { encoding: "utf8", timeout: 30000 });
  expect(r.stdout).toMatch(/real fixtures: \d+ PreToolUse \(all benign\), 0 flagged/);
  expect(r.stdout).toContain("OK: no benign event flagged");
  expect(r.status).toBe(0);
});
