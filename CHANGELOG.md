# Changelog

All notable changes to Veto are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Veto uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-04

### Changed
- **CLI Binary Aliases**: Added `getveto` binary alias to `package.json` so `npx getveto` executes directly without package flag specification.
- **Benchmarks & Documentation**: Added transparent competitive analysis ([docs/COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md)) and runner (`npm run bench:competitive`) with clear evaluation boundaries against model-based guardrails.

## [0.1.0] — 2026-11-03

First public release. Veto is a local safety layer for Claude Code that reviews each tool call against a
set of rules and, in guard mode, blocks dangerous ones before they run. 100% local, sub-35ms p95 latency.

### Added

- **Exfiltration / Secret-to-network (`exfiltration/secret-to-network`)**: High-severity rule that blocks
  local secrets or environment dumps flowing into network clients (`curl`, `wget`, `nc`, `socat`, `scp`,
  `rsync`, `sftp`). Detects piped data (`cat .env | curl`), direct uploads (`curl -d @.env`,
  `wget --post-file .env`), input redirection (`nc host < ~/.ssh/id_rsa`), and command substitutions (`curl -d "$(cat .env)"`).
- **Hook Settings Self-Protection**: Self-protection rules now guard `.claude/settings.json` and
  `.claude/settings.local.json` against agent tampering in addition to `.veto/`.
- **Red-Team Benchmark Dataset**: 34 verified labeled fixtures (`test/fixtures/redteam/`) spanning all
  six evaluation categories (benign, destructive, secret-access, exfiltration, injection-driven, other) with
  100% detection on attack fixtures and 0 false positives on benign fixtures.
- **Interactive Demo Runner**: Added `npm run demo` and VHS tape configuration (`scripts/demo.tape`) to
  visualize Veto guardrail enforcement in the terminal.
- **`veto init`** installs the `PreToolUse` hook into a project's Claude Code settings
  (`.claude/settings.local.json`, or `--shared` for the committed `settings.json`), writes an
  absolute node + CLI path so it works when Claude Code is launched without a shell PATH, and
  backs up any file it changes. `--guard` starts in guard mode. Re-running upgrades an older
  entry in place.
- **Two modes.** Watch (the default) records a verdict for every call and never blocks. Guard
  denies high-severity findings, asks you about medium ones, and logs low ones. `veto mode`
  shows or switches the mode.
- **Rules**, grouped by category, each with a safer-alternative suggestion:
  - *Destructive:* recursive `rm` outside build folders, deleting or moving files outside the
    project, work-discarding git commands (`reset --hard`, `checkout -- .`, `restore`,
    `clean -dx`), force pushes, branch deletes, `git stash drop`/`clear`, `find -delete`,
    recursive `chmod`/`chown`, `dd`, and `mkfs`. Veto reads the order inside one command, so
    `git stash && git reset --hard` is low while a bare `git reset --hard` is high.
  - *File tools:* Read/Write/Edit on secret-looking paths (`.env`, `*.pem`, `*.key`, SSH keys,
    `~/.ssh`, `~/.aws/credentials`, `~/.npmrc`, `~/.netrc`, `*credentials*.json`).
  - *Secret access:* shell reads of those same files (`cat`, `grep`, `sed`, a `< .env` redirect,
    `git show`/`log -p`/`diff` of a secret path), and full environment dumps (`printenv`, `env`,
    `set`, `export -p`).
  - *Exfiltration:* network clients sending local data — `curl`/`wget`/HTTPie with a body or
    upload, `nc`/`socat` reading piped input, and `scp`/`rsync`/`sftp` to a remote host.
  - *Self-protection:* the agent trying to turn Veto off (`veto allow`, `mode watch`,
    `uninstall`, or writing into `.veto/`) is denied in guard mode.
- **Overrides, run by you in your own terminal.** `veto allow --once` lets the next call that
  matches the most recent denial through, once, within 10 minutes, in that project only.
  `veto allow <ruleId>` / `veto deny <ruleId>` turn a rule off or back on. Every override is
  logged.
- **`veto log`** shows recent calls from the nearest `.veto` folder, with `--flagged`,
  `--verbose`, `-n` and `--file`. **`veto status`** summarizes mode, install and recent flags.
  **`veto doctor`** checks Node's version, the hook, config validity and log permissions, and
  prints a fix for anything wrong.
- **Fail-open by design.** Any internal error, invalid config, or slow analysis lets the tool
  call proceed and records the error in `.veto/errors.log`; Veto never emits an "allow" decision
  that would skip your own permission prompt.

### Privacy

- Veto runs entirely on your machine. There is no network code and no telemetry; nothing is ever
  sent anywhere. Logs are written owner-only (`chmod 600`) under `.veto/`.

### Known limitations

- Secret and exfiltration checks match known command shapes and file paths, not contents: a path
  behind a variable or glob, an uncommon client, or a custom script can slip past.
- A secret flowing into a network command is flagged as a medium "ask", not yet a high "deny".
- A request to `localhost` is flagged like any other host.

[0.1.0]: https://github.com/JCHETAN26/GetVeto/releases/tag/v0.1.0
