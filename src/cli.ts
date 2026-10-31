#!/usr/bin/env node
// Veto CLI. `veto hook` is the hot path: it is dispatched before any other module loads.

const argv = process.argv.slice(2);
const cmd = argv[0];

const USAGE = `veto: your agent proposes. You veto.  (observe-only preview)

Usage:
  veto init [--shared]   Install Veto's hook in this project's Claude Code settings.
                         Default: .claude/settings.local.json (personal, gitignored).
                         --shared: .claude/settings.json (committed, applies to your team).
  veto log [-n N]        Show the last N logged tool calls (default 20).
  veto label [--from <project-dir>] [--to <veto-repo-dir>]
                         Label logged PreToolUse calls (allow/flag + category) into
                         <veto-repo>/test/fixtures/redteam/. Resumable; never double-labels.
  veto uninstall         Remove Veto's hook from .claude/settings.local.json and/or .claude/settings.json.
  veto hook              (Called by Claude Code.) Read a hook event on stdin and log it.
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
      const unknown = argv.slice(1).filter((a) => a !== "--shared");
      if (unknown.length) return usageError(`unknown option(s) for init: ${unknown.join(" ")}`);
      const { init } = await import("./install.js");
      return init(process.cwd(), { shared: argv.includes("--shared") }, console.log);
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
      const rest = argv.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "-n" || a === "--number") {
          const v = Number(rest[++i]);
          if (!Number.isInteger(v) || v <= 0) return usageError("-n expects a positive integer");
          n = v;
        } else return usageError(`unknown option for log: ${a}`);
      }
      const { showLog } = await import("./logview.js");
      return showLog(process.cwd(), n, console.log);
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
