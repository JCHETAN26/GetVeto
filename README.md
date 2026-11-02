# Veto

**Your agent proposes. You veto.**

Veto is a safety layer for AI coding agents, starting with [Claude Code](https://code.claude.com). It hooks into
Claude Code's tool-call lifecycle so that, in later releases, it can stop dangerous actions: destructive commands,
secret leaks, and hijacked or off-task behavior. Veto runs 100% locally.

## Status: early preview: watch mode (default) and guard mode

Veto records every tool call Claude Code makes in a project to a local log, so you can see what your agent did.
Before each call it checks the call against its rules and records a verdict: `flag` (with a severity, a
one-sentence reason and a safer alternative) or `allow`.

- **Watch mode** (the default) **blocks nothing**. Veto returns "no decision" (exit 0, empty output), which leaves
  Claude Code's normal permission prompts exactly as they were. `veto log` marks flagged calls with ⚑.
- **Guard mode** (`veto mode guard`) acts on findings. By default high severity is **denied** (Claude gets the
  reason, starting with `Veto:`, and the safer alternative), medium **asks you** in a permission prompt, and low is
  only logged. Per the Claude Code docs, a hook's "ask" still prompts you in auto mode (see
  [docs/hooks-research.md](docs/hooks-research.md) §7). Veto never answers "allow", so it can't skip a prompt you
  would otherwise get. `veto log` marks denied calls ⛔ and asked ones `?`.

Rules so far: recursive `rm` outside regenerable build folders, deleting or moving files outside the project, git
commands that discard work (`reset --hard`, `checkout -- .`, `restore`, `clean -dx`), force pushes, deleting
branches (`git push --delete`, `git push origin :branch`, `git branch -D`), `git stash drop` / `clear`,
`find -delete` / recursive `chmod`/`chown` outside the project, `dd`, `mkfs`, file writes outside the project, and
Read/Write/Edit on secret-looking paths (`.env`, `*.pem`, `*.key`, SSH keys, `~/.ssh`, `~/.aws/credentials`,
`~/.npmrc`, `~/.netrc`, `*credentials*.json`; `.env.example`/`.sample`/`.template` are fine). Shell commands that read
those same files are flagged too: `cat .env`, `grep PORT .env`, `wc -l < .env`, copying them, or printing them from git
history (`git show HEAD:.env`, `git log -p -- .env`). Dumping the whole environment (`printenv`, `env`, `set`,
`export -p`) is logged as low. Veto follows the safe order inside one command:
`git stash && git reset --hard` is low (the changes are stashed first), while `git stash && git stash drop` is high.
If Veto itself fails or crashes, or its config is invalid, the tool call goes ahead with no decision and the error
goes to `.veto/errors.log`.

### Overrides: your call, in your terminal

When guard mode blocks something you actually want, run one of these **yourself**, in your own terminal:

- `veto allow --once`: the next tool call in this project whose blocking findings match the most recent denial goes
  ahead, once, within 10 minutes. Then ask Claude to retry. A call with a different finding is still blocked.
- `veto allow <ruleId>` / `veto deny <ruleId>`: stop checking one rule in this project, or check it again (edits
  `disabledRules` in `.veto/config.json`).

Overrides apply only to the project they were made in, and each one is recorded in `.veto/log.jsonl` (`veto log`
shows them). The agent can't grant itself one: in guard mode, Claude running `veto allow`, `veto mode watch` or
`veto uninstall`, or writing into `.veto/`, is denied (`self-protection/override`), and the reason tells you to run it
in your own terminal if you agree.

### `.veto/config.json`

Created by `veto init`. All fields are optional:

```json
{
  "mode": "watch",
  "actions": { "high": "deny", "medium": "ask", "low": "log" },
  "disabledRules": []
}
```

`mode` is `"watch"` or `"guard"`; each action is `"deny"`, `"ask"` or `"log"`; `disabledRules` lists rule ids
(e.g. `"destructive/broad"`). An invalid file makes Veto behave as in watch mode and logs the error.

## Install

Requires Node.js 22 or newer. Claude Code runs Veto as a new process before every tool call, so startup time is
what you feel. Node 22 can cache Veto's compiled code (below), which keeps a Bash check under about 30 ms; Node 20 has
no such cache (about 40 ms) and reached end-of-life on 2026-04-30 (see [docs/decisions.md](docs/decisions.md) D3).

```sh
npm install -g getveto
```

The package is not on npm yet. Until then, from a clone of this repo: `npm install && npm run build && npm link`.

On Node 22.1 and newer, Veto keeps Node's compile cache for its own code in `$XDG_CACHE_HOME/getveto` (default
`~/.cache/getveto`, about 50 KB per Node version and Veto build), which makes each hook call a few ms faster. It holds
only compiled Veto code, never your data. You can delete it at any time, and `VETO_NO_COMPILE_CACHE=1` turns it off.

## Use

```sh
cd your-project
veto init          # install the hook for this project (just for you)
claude             # use Claude Code as usual; accept the folder-trust prompt
veto log           # see what it did
```

## Commands

| Command | What it does |
|---|---|
| `veto init` | Adds Veto's hook (with absolute paths, see below) to **`.claude/settings.local.json`** in the current folder. That file is your personal, project-only settings file and is kept out of git. Veto also adds `.veto/` and `.claude/settings.local.json` to `.gitignore`. |
| `veto init --guard` | Same, and starts in guard mode (can be combined with `--shared`). |
| `veto mode [watch\|guard]` | Shows the mode, or sets it in `.veto/config.json`. Takes effect on Claude Code's next tool call. |
| `veto status` | Mode, whether the hook is in `.claude/settings.local.json` / `.claude/settings.json`, the config path, and the last 5 flagged calls. |
| `veto init --shared` | Adds the hook (as plain `veto hook`, see below) to **`.claude/settings.json`** instead. That's the file teams commit, so everyone working in the repo gets Veto. Teammates who don't have `veto` installed will see a non-blocking "hook error" notice on each tool call. |
| `veto log [-n N] [--flagged] [--verbose] [--file <log.jsonl>]` | Prints the last N tool calls (default 20) as a timeline: time, event (`pre` / `post` / `FAIL`), tool, and a one-line summary such as the command or file path. It reads the log of the nearest `.veto` folder at or above the current directory, like git. Flagged calls end with `⚑ severity: reason` (guard mode: `⛔ denied` / `? asked`; `✓ allowed once by you` after `veto allow --once`); `--flagged` shows only those, and `--verbose` lists every finding instead of `(+N more)`. `--file` reads a saved copy of a log (e.g. one kept before rebuilding a sandbox). |
| `veto allow --once` | Lets the next call matching the most recent denial go ahead, once, within 10 minutes (see Overrides). |
| `veto allow <ruleId>` / `veto deny <ruleId>` | Stops checking a rule in this project, or checks it again. |
| `veto label [--from <dir>] [--to <repo>]` | Walks through the logged `PreToolUse` calls in `<dir>/.veto/log.jsonl` (default: current folder) that aren't labeled yet. For each one it shows the full command or path, the time, whether it ran or got no post event (denied/interrupted), and the prompt behind it. You press keys to label it: verdict `a`llow / `f`lag, a category (benign, destructive, secret-access, exfiltration, injection-driven, other), the scenario number, and an optional note. Each label is saved as `<repo>/test/fixtures/redteam/<id>.json` (default repo: the GetVeto checkout `veto` runs from), with the event redacted the same way `capture-fixtures` does. You can quit at any time with `q` and resume later; nothing is ever labeled twice. |
| `veto uninstall` | Removes Veto's hook from whichever of `.claude/settings.local.json` and `.claude/settings.json` contain it, leaving all your other settings and hooks untouched. Your `.veto/` logs are kept. |
| `veto hook` | What Claude Code runs. You don't call it yourself. |

How `init` and `uninstall` behave:

- **Project-level only.** Veto never touches `~/.claude/settings.json`.
- **Idempotent.** Running `veto init` twice changes nothing the second time.
- **Backups first.** Any settings file Veto changes is copied to `.veto/backups/` before it's modified.
- **Transparent.** Both commands print every file they create, change, or delete.
- **Valid JSON only.** If a settings file isn't valid JSON, Veto refuses to touch it.

Veto registers itself on Claude Code's `PreToolUse`, `PostToolUse` and `PostToolUseFailure` events (matcher `*`), and
on `UserPromptSubmit` (so a tool call can be traced back to the prompt that caused it), each with a 10-second timeout. See [docs/hooks-research.md](docs/hooks-research.md) for how Claude Code hooks work.

### How the hook command is written

| | Hook command written | Why |
|---|---|---|
| `veto init` (local) | Absolute paths: `<node binary> <veto install>/dist/cli.js hook`, e.g. `/home/you/.nvm/versions/node/v22.14.0/bin/node /home/you/.../getveto/dist/cli.js hook` | Works even when Claude Code is launched from the desktop app or an IDE that doesn't load your shell's `PATH` (for example nvm). |
| `veto init --shared` | `veto hook`, looked up on `PATH` | The file is committed. Absolute paths would expose your machine's folder layout and wouldn't exist on teammates' machines. Each teammate needs `veto` on their `PATH`. |

Re-running `veto init` upgrades an older Veto entry **in place**: a relative `veto hook`, or an absolute path from a
Node version or install location you no longer use. Its position and every other hook are kept, and running it again
after that changes nothing. **Re-run `veto init` after switching Node versions (e.g. `nvm use`) or moving or
reinstalling Veto**, because the absolute paths point at the old location. Until then, Claude Code shows a
non-blocking "hook error" and nothing is logged.

## What Veto does not cover

- **Commands you type yourself.** Veto sees only the tool calls Claude Code makes. What you run in your own terminal
  never reaches it.
- **Sessions in folders without Veto installed.** The hook is installed per project (`veto init`). A Claude Code
  session started in a folder where you didn't run `veto init` isn't checked or logged at all.
- **Secrets outside the list, or behind a variable.** Secret checks go by file path (the list above), not file
  contents, and a path in a variable, glob or `$(...)` (`cat $F`, `cat *.pem`) isn't flagged. Programs other than the
  common readers (a script that opens `.env` itself, `python -c ...`) aren't caught either.
- **Exfiltration.** That rule category exists but is still empty: Veto doesn't yet catch sending data off the machine.
- **Every way to switch Veto off.** It blocks the direct routes (`veto allow`/`mode watch`/`uninstall` and writes into
  `.veto/` by the agent), not every script that could edit `.veto/` or `.claude/settings*.json`.

## Privacy

- Veto runs entirely on your machine. **Nothing is ever sent anywhere.** There's no network code and no telemetry.
- **Logs may contain sensitive data.** `.veto/log.jsonl` stores each hook event as Claude Code sends it. That includes
  commands, the prompts you type, file paths, and the contents of files Claude reads, writes, or edits, and it can
  include secrets.
- **Size cap.** Any string inside a tool's input or output longer than 4 KB is cut to its first 4 KB and followed by a
  marker with the original length and a sha256 of the full value. A shell command (Bash/PowerShell `command`) is kept
  up to 16 KB, since the command is what matters most. Entries that were cut list the affected fields in `truncated`.
- `.veto/` is created owner-only (directory `0700`, files `0600`) and is added to `.gitignore`. Some filesystems,
  such as exFAT and FAT32 drives, ignore Unix permissions. On those, the files are readable by anyone with access to
  the drive.
- To delete your history, remove the `.veto/` folder.
- Veto writes nowhere else, except Node's compile cache for Veto's own code (see Install).

## Development

```sh
npm install
npm run build       # tsc -> build/ (tooling), then esbuild -> dist/ (what ships: one CommonJS bundle)
npm test            # builds, then runs unit + integration tests against the built CLI
npm run bench       # hook latency over the real fixtures; compare builds with
                    #   node scripts/bench-hook.mjs --only-pre --bash --cli <a>/dist/cli.js --cli <b>/dist/cli.js
npm run capture-fixtures -- --from ~/veto-sandbox -n 20   # copy real, redacted payloads into test/fixtures/real/
```

### Red-team dataset

```sh
npm run redteam:setup               # build the disposable sandbox ~/veto-redteam (+ local remote ~/veto-redteam-remote.git)
npm run redteam:setup -- --reset    # rebuild it (only folders carrying our marker; keeps you from deleting recorded logs)
veto label --from ~/veto-redteam    # label what Claude Code did there
npm run redteam:stats               # counts by verdict / category; warns when a category has < 5 examples
```

See [redteam/PLAYBOOK.md](redteam/PLAYBOOK.md) for the safety rules and scenarios, and
[redteam/templates/README.md](redteam/templates/README.md) for adding your own sandbox files.

Project rules for contributors (and AI agents) are in [CLAUDE.md](CLAUDE.md).

## License

MIT
