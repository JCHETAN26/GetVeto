#!/usr/bin/env node
// Veto CLI. `veto hook` is the hot path: it is dispatched before any other module loads.

const argv = process.argv.slice(2);
const cmd = argv[0];

const USAGE = `veto: your agent proposes. You veto.  (preview)

Usage:
  veto init [--shared] [--guard]
                         Install Veto's hook in this project's Claude Code settings.
                         Default: .claude/settings.local.json (personal, gitignored).
                         --shared: .claude/settings.json (committed, applies to your team).
                         --guard: start in guard mode (default: watch mode).
  veto mode [watch|guard]
                         Show or set the mode. watch: flag in the log, never block.
                         guard: deny high-severity calls, ask you about medium ones.
  veto status            Mode, where the hook is installed, config path, last 5 flags.
  veto allow --once      Let the next call that matches the most recent denial go ahead,
                         once, within 10 minutes, in this project only.
  veto allow <ruleId>    Stop checking one rule in this project (adds it to disabledRules).
  veto deny <ruleId>     Check that rule again (removes it from disabledRules).
                         Run these yourself: Veto denies them when the agent runs them.
  veto log [-n N] [--flagged] [--file <log.jsonl>]
                         Show the last N logged tool calls (default 20). Flagged calls
                         end with ⚑ severity: reason (guard mode: ⛔ denied / ? asked).
                         --flagged shows only those.
                         --file reads a saved log instead of ./.veto/log.jsonl.
  veto label [--from <project-dir>] [--to <veto-repo-dir>]
                         Label logged PreToolUse calls (allow/flag + category) into
                         <veto-repo>/test/fixtures/redteam/. Resumable; never double-labels.
  veto uninstall         Remove Veto's hook from .claude/settings.local.json and/or .claude/settings.json.
  veto hook              (Called by Claude Code.) Read a hook event on stdin, check it against
                         the rules, log it, and in guard mode deny or ask.
  veto --version
`;

async function main(): Promise<number> {
  switch (cmd) {
    case "hook": {
      const { runHook } = await import("./hook.js");
      runHook(); // exits the process itself
      return -1;
    }
    case "init": {
      const unknown = argv.slice(1).filter((a) => a !== "--shared" && a !== "--guard");
      if (unknown.length) return usageError(`unknown option(s) for init: ${unknown.join(" ")}`);
      const { init } = await import("./install.js");
      return init(process.cwd(), { shared: argv.includes("--shared"), guard: argv.includes("--guard") }, console.log);
    }
    case "mode": {
      const rest = argv.slice(1);
      if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== "watch" && rest[0] !== "guard")) {
        return usageError("usage: veto mode [watch|guard]");
      }
      const { showMode, setMode } = await import("./status.js");
      return rest[0] ? setMode(process.cwd(), rest[0], console.log, (m: string) => process.stderr.write(`veto: ${m}\n`)) : showMode(process.cwd(), console.log);
    }
    case "status": {
      if (argv.length > 1) return usageError("status takes no options");
      const { showStatus } = await import("./status.js");
      return showStatus(process.cwd(), console.log);
    }
    case "allow":
    case "deny": {
      const rest = argv.slice(1);
      const err = (m: string) => process.stderr.write(`veto: ${m}\n`);
      const { allowOnce, setRule } = await import("./override-cli.js");
      if (cmd === "allow" && rest.length === 1 && rest[0] === "--once") return allowOnce(process.cwd(), console.log, err);
      if (rest.length !== 1 || rest[0]!.startsWith("-")) return usageError(`usage: veto ${cmd === "allow" ? "allow --once | veto allow <ruleId>" : "deny <ruleId>"}`);
      return setRule(process.cwd(), rest[0]!, cmd === "deny", console.log, err);
    }
    case "uninstall": {
      if (argv.length > 1) return usageError(`uninstall takes no options`);
      const { uninstall } = await import("./install.js");
      return uninstall(process.cwd(), console.log);
    }
    case "label": {
      const { runLabel } = await import("./label-cli.js");
      return runLabel(argv.slice(1));
    }
    case "log": {
      let n = 20;
      let flagged = false;
      let file: string | undefined;
      const rest = argv.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "-n" || a === "--number") {
          const v = Number(rest[++i]);
          if (!Number.isInteger(v) || v <= 0) return usageError("-n expects a positive integer");
          n = v;
        } else if (a === "--flagged") flagged = true;
        else if (a === "--file") {
          file = rest[++i];
          if (!file) return usageError("--file expects a path to a log file");
        } else return usageError(`unknown option for log: ${a}`);
      }
      const { showLog } = await import("./logview.js");
      return showLog(process.cwd(), n, console.log, { flagged, file, err: (m) => process.stderr.write(`veto: ${m}\n`) });
    }
    case "--version":
    case "-v": {
      const { readFileSync } = await import("node:fs");
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      console.log(pkg.version);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      return usageError(`unknown command: ${cmd}`);
  }
}

function usageError(msg: string): number {
  process.stderr.write(`veto: ${msg}\n\n${USAGE}`);
  return 1;
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (cmd === "hook") process.exit(0); // fail open, never reached in practice
    process.stderr.write(`veto: ${(e as Error)?.message ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
