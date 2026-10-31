# Decisions

## D1. Shell parser for the Bash command analyzer: `unbash` (pinned 6.0.2)

**Date:** 2026-10-31. **Status:** chosen and pinned in `package.json`. The analyzer that uses it is not built yet.

### Why we need one
Claude Code does most of its work through the Bash tool. Reads, edits and listings all showed up as
shell commands in our real captures (`test/fixtures/real/`). Splitting the command string on spaces
gets chains, quoting, substitutions and heredocs wrong, so the analyzer needs a real parser.

### Requirements
- Correct on: `; && || |`, subshells, `$(...)` and backticks, single/double/ANSI-C quoting and
  escapes, `FOO=1 cmd` prefixes, redirections, heredocs (quoted and unquoted delimiters).
- Pure JS/TS, no native addon (the CLI is installed with plain `npm i -g`).
- Small startup cost: `veto hook` runs on every tool call, and the p95 target is under 50 ms
  including Node startup.
- Maintained, permissive license.

### Candidates and what we measured
Measured on 2026-10-31 on the founder's Linux machine (Node v22.14.0, 16 cores, load average 3–8),
using one-off scripts in a scratch directory rather than in this repo. Each figure is one `node`
process, timed with `performance.now()`.

| Parser | Version | What it is | Import | First parse | Correctness on our constructs |
|---|---|---|---|---|---|
| `shell-quote` | 1.12.0 | tokenizer | negligible | negligible | **Fails.** Splits `$(` into `$` + `(`, leaves backticks as literal text, and breaks heredocs into separate words. Not a parser. |
| `sh-syntax` | 0.7.0 | WASM build of the Go parser mvdan/sh | ~9.5 ms | ~13–16 ms (WASM init + async API) | Correct (mature parser), but ~23 ms per hook call before any rule runs, and the API is async. |
| **`unbash`** | **6.0.2** | pure TypeScript Bash parser, zero dependencies | ~9–11 ms (~8.7 ms with Node's compile cache) | ~2 ms for a simple command; ~8 ms for six mixed commands cold | **Correct** on every construct above: env prefixes, chains, pipes, `$(...)`/backticks (parsed into nested scripts), quoting (gives both source text and the unquoted value), `\rm`, globs as structured parts, redirects with fd numbers, and heredocs (quoted delimiter = no expansion parts). |

The old `bash-parser` (last release 2022, many small dependencies) and `mvdan-sh` (deprecated on
npm) were ruled out without measuring. `tree-sitter-bash` needs a native addon or a WASM runtime
(20 MB unpacked), and its own benchmarks show it is slower to parse.

Baseline `veto hook` latency before any analyzer code (`npm run bench`, 300 runs over the real
PreToolUse fixtures): Bash p50 ≈ 28–30 ms, p95 ≈ 31–33 ms. Non-Bash p50 ≈ 27–28 ms, p95 ≈ 30–32 ms.
Adding unbash's ~11 ms on Bash events only should leave p95 under 50 ms. That still has to be
measured once the analyzer exists.

### Decision
Use `unbash`, pinned to the exact version `6.0.2` (no `^` or `~`):
- it was the only candidate that was correct, synchronous, pure JS, and cheap enough
- its README names "classify scripts for permission prompts" as a target use case
- it is tolerant: malformed input returns a partial tree plus `errors` instead of throwing, which
  fits our fail-open rule
- maintainer Lars Kappert (author of knip), ISC license, actively released (6.0.2 on 2026-10-30;
  its fixes include heredoc detection inside parameter expansions)

### Consequences and how to apply
- **Exact pin:** unbash shipped breaking majors v4 → v6 within about a month. Upgrades must be
  deliberate. Read the release notes, then re-run the full suite.
- **Lazy loading:** load it with a dynamic `import()` only for Bash PreToolUse events, so Read, Edit,
  Write and the other events don't pay the import cost.
- **Errors:** treat `errors` on the returned tree as "analysis incomplete", never as a crash.
- **Compile cache:** `module.enableCompileCache()` (Node ≥ 22.1) saved only about 2 ms and writes a
  cache directory to disk, so it is not enabled.
- **Scope:** unbash parses Bash only. PowerShell tool calls need a separate decision.
