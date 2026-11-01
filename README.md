# Veto

**Your agent proposes. You veto.**

Veto is a safety layer for AI coding agents, starting with [Claude Code](https://code.claude.com). It hooks into
Claude Code's tool-call lifecycle so that, in later releases, it can stop dangerous actions: destructive commands,
secret leaks, and hijacked or off-task behavior. Veto runs 100% locally.

## Status: early preview, watch mode

This release **blocks nothing**. It records every tool call Claude Code makes in a project to a local log, so you can
see what your agent did. Before each call it also checks the call against its rules and records a verdict: `flag`
(with a severity and a one-sentence reason) or `allow`. `veto log` marks flagged calls with ⚑, and
`veto log --flagged` lists only those. On every call, Veto still returns "no decision" (exit 0, empty output), which
leaves Claude Code's normal permission prompts exactly as they were.

Rules so far: recursive `rm` outside regenerable build folders, git commands that discard work (`reset --hard`,
`checkout -- .`, `restore`, `clean -dx`), force pushes, `find -delete` / recursive `chmod`/`chown` outside the project,
`dd`, `mkfs`, file writes outside the project, and Read/Write/Edit on secret-looking paths (`.env`, `*.pem`, `~/.ssh`). If Veto itself fails or crashes, the tool call goes ahead and the
error goes to `.veto/errors.log`.

## Install

Requires Node.js 20 or newer.

```sh
npm install -g getveto
```

The package is not on npm yet. Until then, from a clone of this repo: `npm install && npm run build && npm link`.

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
| `veto init --shared` | Adds the hook (as plain `veto hook`, see below) to **`.claude/settings.json`** instead. That's the file teams commit, so everyone working in the repo gets Veto. Teammates who don't have `veto` installed will see a non-blocking "hook error" notice on each tool call. |
| `veto log [-n N] [--flagged] [--file <log.jsonl>]` | Prints the last N tool calls (default 20) as a timeline: time, event (`pre` / `post` / `FAIL`), tool, and a one-line summary such as the command or file path. Flagged calls end with `⚑ severity: reason`; `--flagged` shows only those. `--file` reads a saved copy of a log (e.g. one kept before rebuilding a sandbox) instead of `./.veto/log.jsonl`. |
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

## Development

```sh
npm install
npm test            # builds, then runs unit + integration tests against the built CLI
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
