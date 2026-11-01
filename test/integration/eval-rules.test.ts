// Runs scripts/eval-rules.mjs (built engine) as a subprocess: no real fixture or allow-labeled
// example may be flagged.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO } from "../helpers.js";

it("eval-rules: real fixtures get their expected verdicts; no benign one or allow-labeled example is flagged", () => {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "eval-rules.mjs")], { encoding: "utf8", timeout: 30000 });
  expect(r.stdout).toMatch(/real fixtures: \d+ PreToolUse; \d+ benign, 0 of them flagged; \d+ expected to flag/);
  expect(r.stdout).not.toMatch(/^\s+✗ /m); // every expected flag matched
  expect(r.stdout).toMatch(/✓ 17-PreToolUse-Bash\.json .* expected flag \[destructive\/delete-outside-project\], got flag/);
  expect(r.stdout).toContain("OK: no benign event flagged");
  expect(r.status).toBe(0);
});
