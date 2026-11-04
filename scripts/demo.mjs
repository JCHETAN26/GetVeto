#!/usr/bin/env node
// Interactive / visual demo runner that demonstrates Veto intercepting dangerous calls.
// Run with: node scripts/demo.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  console.clear();
  console.log(bold("=== Veto Interactive Product Demo ===\n"));
  await sleep(1000);

  console.log(`${cyan("$")} ${bold("veto init --guard")}`);
  await sleep(800);
  console.log(green("✓ Installed PreToolUse hook into .claude/settings.local.json"));
  console.log(green("✓ Mode set to guard (high: deny, medium: ask, low: log)"));
  console.log(green("✓ Created owner-only directory .veto/ (mode 0700)\n"));
  await sleep(1500);

  console.log(`${cyan("$")} ${bold("claude")}`);
  await sleep(800);
  console.log(dim("Claude Code v2.1 (running with Veto guardrails enabled)\n"));
  await sleep(1000);

  console.log(`${yellow(">")} Clean up my workspace and discard unstaged changes\n`);
  await sleep(1500);

  console.log(`${dim("[Agent proposing Tool Call]")} ${bold("Bash:")} git reset --hard HEAD\n`);
  await sleep(1200);

  console.log(red(bold("⛔ Veto Intercept: BLOCKED (High Severity)")));
  console.log(red("  [destructive/git-discard] git reset --hard discards uncommitted changes."));
  console.log(cyan("  💡 Safer: Run `git stash` first so changes can be restored, or confirm with the user."));
  console.log(dim("  Hint: The user can run `veto allow --once` in their terminal to allow this specific call.\n"));
  await sleep(2500);

  console.log(`${cyan("$")} ${bold("veto log --flagged")}`);
  await sleep(800);
  console.log(dim("16:42:01  pre   Bash  git reset --hard HEAD"));
  console.log(`         ${red("⚑ high: git reset --hard discards uncommitted changes")} ${red("⛔ denied")}\n`);
  await sleep(2000);

  console.log(`${cyan("$")} ${bold("veto allow --once")}`);
  await sleep(800);
  console.log(green("✓ Allowed once within 10 minutes: destructive/git-discard"));
  console.log(dim("  The next call matching this signature will be permitted through.\n"));
  await sleep(1000);

  console.log(bold(green("Demo complete. Your agent proposes. You veto.\n")));
}

main().catch(console.error);
