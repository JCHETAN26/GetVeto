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

**Update, same day (Task #3a):** with the same files on the same disk, re-running the identical scratch
script later gave 15–18 ms for the unbash import (it was ~11 ms earlier). In-repo, `npm run bench`
(`scripts/bench-parse.mjs`) measured 16–21 ms for the import, 2–4.5 ms for the first parse, and 1–40 µs
per warm parse. So plan on **roughly 10–20 ms of import cost on Bash events, depending on machine
load**. Lazy loading keeps it off every other event.

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
  cache directory to disk, so it is not enabled. *(Superseded by D3: with the code in one bundle it is enabled.)*
- **Scope:** unbash parses Bash only. PowerShell tool calls need a separate decision.

## D2. Rule engine startup cost (watch mode)

**Date:** 2026-10-31. **Status:** in place.

Wiring the engine into `veto hook` first added about 20 ms to Bash events and 9 ms to every other
PreToolUse event. Measured with `scripts/bench-hook.mjs`, 300 runs, interleaved with a build of
the pre-engine commit (0383cf4) at the same machine load (load average 2.4–4.8):

| | Bash p50 / p95 | non-Bash p50 / p95 |
|---|---|---|
| before the engine (0383cf4) | 25.4 / 26.6–27.7 ms | 25.4 / 26.6–29.4 ms |
| engine, everything loaded up front | 45.4–45.9 / 48.0–51.2 ms | 33.9–34.0 / 36.8–37.4 ms |
| **engine, lazy per tool + parse prefilter** | **32.6–32.7 / 45.3–45.8 ms** | **29.7–30.0 / 30.8–31.6 ms** |

The parse prefilter has no effect on p95: the slowest commands are the ones that need the parser.

What made the difference:
- **Category modules load per tool.** Bash loads destructive (plus the placeholders), the file tools
  load file-tools, and Glob, Grep and the rest load no rule module at all.
- **`child_process` is required only when a git check runs.** That's about 3 ms otherwise.
- **Parse prefilter.** Each Bash rule declares `triggers`, the program names it can match. When
  none of them appears as a word in the command (after removing backslash-newlines, backslashes
  and quotes, as bash does when it forms a word), the ~14 ms parser import is skipped. `$'...'`
  always parses. A unit test checks that skipping never changes the findings.

Commands that do need the parser (e.g. `git status`) still pay the unbash import, so they land
around 45 ms, close to the 50 ms p95 target on a loaded machine.

**Not enabled, for the founder to decide:** Node's compile cache (`NODE_COMPILE_CACHE` or
`module.enableCompileCache()`). On the same benchmark it took Bash p50 from 45.0 to 41.0 ms and
p95 from 48.3 to 42.2–45.2 ms. It writes about 200 KB of cache to disk, which D1 chose not to do.
**Update (D3):** enabled now, after bundling: ~50 KB per Node version and Veto build in `~/.cache/getveto`.

## D3. Hook startup speed: one CommonJS bundle plus Node's compile cache

**Date:** 2026-11-01. **Status:** in place. **Goal (Task #5):** Bash p95 at or under 35 ms on the founder's machine,
with no verdict changes.

Machine for every number below: the founder's Linux box, 16 cores, `powersave` governor, Node v22.14.0 unless noted.
The load average stayed between 2.5 and 4.2 throughout, because other processes (containers, a JVM) kept bursting CPU.
Absolute numbers therefore move by several ms from run to run. Every comparison here comes from one **interleaved** run,
where the builds take turns call by call, so they all see the same load. `scripts/bench-hook.mjs` does this now when
given several `--cli`.

### 1. Profile: where a Bash hook call spent its time (Task #4 build, tsc ESM output)

Spawn-to-exit wall time, interleaved, 80 runs each, load 3.2 → 2.7:

| process | p50 | p95 |
|---|---|---|
| `node -e ''` (Node startup alone) | 17.3 | 19.6 |
| a CommonJS script that reads stdin and exits | 20.4 | 22.5 |
| `veto hook`, Read event | 32.5 | 37.1 |
| `veto hook`, Bash `ls` (prefilter skips the parser) | 36.2 | 43.0 |
| `veto hook`, Bash `git status` (parser loaded) | 48.2 | 61.1 |
| `veto hook`, Bash `git reset --hard` with uncommitted changes (parser + `git status` check) | 56.2 | 62.9 |

Inside one process: medians over 40 fresh processes, each step timed with `performance.now()`, Bash `git status` /
`git reset --hard` events:

| step | ms |
|---|---|
| Node bootstrap until the first line of our code | ~17 |
| ESM loader itself (empty `.mjs` vs empty `.cjs`, spawn p50) | ~3.8 |
| reading stdin through `process.stdin` (loads Node's stream and net modules) | ~3 |
| import `hook.js` + config, decide, storage, truncate | 4.2 |
| import `engine.js` | 0.9 |
| import the destructive rule modules (9 files) | 5.7 |
| import `unbash` | 9.0 |
| import `shell/parse.js` | 2.0 |
| evaluate, including the first (cold) parse | 4.0 |
| … plus the `git status` child process (discard commands only) | +8 |
| loadConfig / decide / formatLogLine / log append | 0.35 / 0.2 / 0.45 / 0.3 |

Module loading (≈22 ms on a parser event) was the largest cost we could remove. Rule execution, config and log I/O
together were under 2 ms, and sync fs calls were not a measurable cost. The `git status` check costs ~8 ms but only
runs for work-discarding git commands. A cheaper call would change what it reports (e.g. skipping untracked files),
so it stays as it is.

### 2. Options measured

**Builds**, interleaved, 80 runs each, load 3.2 → 2.7, p50 / p95 ms (`cc` = Node's compile cache):

| build | Read | Bash `ls` | Bash `git status` | Bash `git reset --hard` |
|---|---|---|---|---|
| tsc ESM, many files (before) | 32.5 / 37.1 | 36.2 / 43.0 | 48.2 / 61.1 | 56.2 / 62.9 |
| (b) tsc ESM + cc (separate run: 48.9 → 45.1 p50 on `git status`) | | | | |
| (c) V8 startup snapshot of hook + engine + rules + unbash | 30.6 / 34.7 | 31.1 / 36.1 | 33.3 / 37.6 | 40.9 / 44.0 |
| (a) esbuild ESM bundle, code-split per lazy import | 33.2 / 35.4 | 33.4 / 36.3 | 40.4 / 45.2 | 48.2 / 53.9 |
| (a+b) ESM split bundle + cc | 32.7 / 36.8 | 32.8 / 38.3 | 37.1 / 40.5 | 45.0 / 53.3 |
| (a) esbuild CommonJS, one file | 29.1 / 33.1 | 29.9 / 32.7 | 33.2 / 35.5 | 40.4 / 44.9 |
| **(a+b) CommonJS one file + cc** | **25.8 / 27.7** | **26.1 / 29.6** | **29.3 / 32.7** | **37.4 / 41.9** |

**Cheap wins (d)**, each measured interleaved against the build before it (150 runs, load 2.4–3.2):
- `performance.now()` → `process.hrtime.bigint()`: using the `performance` global loads Node's perf_hooks modules.
  p50 −0.4 to −0.9 ms on all four events. **Taken.**
- Minifying whitespace and syntax (identifiers kept): 360 KB → 230 KB, p50 −0.9 to −1.0 ms on all four. **Taken.**
- Reading stdin with `fs.read` on fd 0 instead of `process.stdin`: −2.6 ms in isolation. **Rejected: it can hang.** When
  stdin is never closed, the read blocks in a libuv thread-pool thread, and at `process.exit()` libuv joins that thread,
  so the process never exits. The 2 s stdin guard no longer works. Reproduced: still running after 6 s, killed. With the
  stream it exits after 2.08 s. Fail-open (CLAUDE.md rule 3) wins.
- Node flags in the hook command: `--v8-pool-size=0` +0.9 ms, `--jitless` +5 ms, `--max-semi-space-size=1` +5.6 ms,
  `--single-threaded` +5.6 ms. All slower. It isn't a cache miss: Node keeps a separate compile-cache directory per V8
  flag set, and the warm-up filled it. The cause wasn't investigated further. **Rejected.**

**Costs of each option**
- **(a) bundle:** adds an `esbuild` devDependency, pinned to 0.28.2 (the version vitest already had installed). `unbash`
  becomes a devDependency because it is compiled into `dist/veto.js`, and its ISC license ships in
  `dist/THIRD_PARTY_LICENSES.txt`. `npm install -g` now installs no runtime dependencies. Stack traces in
  `.veto/errors.log` point into one minified file, but function names are kept. The tsc output moves to `build/`, used
  only by tooling (eval, bench-parse, capture-fixtures, redteam-stats). `dist/cli.js` stays the entry path (with
  `dist/package.json` `{"type":"commonjs"}`), so existing hook commands and `veto init` keep working unchanged.
- **(b) compile cache** (revisits D1/D2): one ~50 KB file per (Node version, Veto build) in `$XDG_CACHE_HOME/getveto` or
  `~/.cache/getveto`. That is the only write outside `.veto/`, and `VETO_NO_COMPILE_CACHE=1` turns it off. Node ≥ 22.1
  only: Node 20 has no `module.enableCompileCache` and runs without it. Old entries are not pruned automatically, so
  each upgrade leaves ~50 KB behind. Node validates each entry against the source and V8 flags and recompiles on any
  mismatch, and a corrupted entry is ignored (tested). D2 rejected the cache when it saved ~4 ms for 200 KB across
  many files. With one bundle it saves 3–4 ms more for a quarter of the size, and it is what brings Bash p95 under
  35 ms, so it is now on.
- **(c) startup snapshot:** a 6.2 MB blob per Node version, built on the user's machine because it is tied to the exact
  Node binary. The hook command would need `--snapshot-blob` (every user re-runs `veto init`). Node warns that
  `node:module` "is not yet fully verified" in snapshots. It is also slower than (a+b): deserializing the blob costs more
  than loading a cached 230 KB bundle. **Rejected.**
- **Background daemon:** not built (out of scope), and **not needed**. The floor is Node's own startup, ~17 ms (~20 ms
  with stdin), and the hook now runs about 5 ms above it on Bash. A daemon only pays off if the per-call client is not
  Node (a native binary or a shell client talking to a socket), because a Node client pays that floor anyway. Revisit
  only if rules ever need warm state that is expensive to build.

### 3. Result: before (Task #4, 91de286) vs after, real fixtures (`bench-hook.mjs --only-pre`), interleaved, 200 runs

| | before p50 / p95 | after p50 / p95 | load |
|---|---|---|---|
| Bash, watch | 37.6 / 50.6 | **25.4 / 29.7** | 3.6 |
| Bash, guard | 37.3 / 50.6 | **25.4 / 29.5** | 3.5 |
| non-Bash, watch | 33.2 / 36.7 | **24.5 / 27.0** | 3.4 |
| non-Bash, guard | 33.3 / 36.2 | **24.6 / 27.2** | 3.1 |
| Bash, no compile cache (first call after install/upgrade, or `VETO_NO_COMPILE_CACHE=1`) | 37.3 / 50.4 | 28.6 / 33.5 | 2.9 |
| non-Bash, no compile cache | 33.3 / 37.1 | 27.5 / 29.4 | 3.1 |
| Node 20.20.2, Bash (no compile cache on Node 20) | 43.5 / 57.3 | 34.3 / 40.0 | 3.2 |
| Node 20.20.2, non-Bash | 39.2 / 44.6 | 33.3 / 37.5 | 3.7 |

Two Bash watch runs hit CPU bursts from other processes. Both builds suffered and the ratio held: before 38.0 / 111.1
vs after 25.9 / 73.9 at load 3.8, and before 38.7 / 124.7 vs after 26.6 / 77.3 at load 3.2. The repeat at load 3.6 in
the table was clean.

**Target met on Node 22:** Bash p95 29.5–29.7 ms (≤ 35 ms) in clean runs. **Not met on Node 20:** p95 40 ms. Node 20
has no compile cache, and it reached end-of-life on 2026-04-30. Closing that gap would mean hand-rolling a V8 code cache
(`vm.Script` `cachedData`), which isn't worth it for an EOL runtime.

**No behavior change:** `npm run eval` output was diffed before vs after over the real fixtures, `~/veto-sandbox`, and
both saved red-team logs (48 PreToolUse events), with the timing line excluded: identical. A CLI-level replay ran 64
cases through `dist/cli.js hook` (every real fixture plus 13 dangerous and benign commands in watch and guard mode,
plus invalid JSON) comparing stdout, exit code and the logged verdict/findings/decision: identical on Node 22 and on
Node 20.

## D4. Following Veto's own advice, and overrides (Task #6, 2026-11-01)

**Problem (guard-mode test, 2026-10-31 23:20).** Veto denied `git reset --hard` and advised "Run `git stash` first".
Claude did exactly that in one command (`git stash push -m ... && git reset --hard HEAD~1`) and was denied again,
because `git status` runs before the chain does. The user had no way to let a call through either.

**Decisions.**
- *Order inside one command.* The parser records, per command, which earlier commands have certainly run
  (`ranBefore`: earlier `&&` steps; the first step of earlier `;`/newline statements; nothing across `||`, pipes,
  `!`, `&`, subshells or if/loop bodies). git-discard drops to **low** when a full stash of the same work tree ran
  first. `;` is accepted as the task asked, though a failed stash would not stop the reset there; `||` is not. A plain
  stash doesn't save untracked files, so `git clean -d` needs `-u` and `-x` needs `-a`. A partial stash (`-p`,
  `--staged`, pathspecs), a `stash pop` in between, or a `stash drop`/`clear` anywhere keeps the old severity.
- *`veto allow --once` matches findings, not command text.* It covers the next call whose blocking findings are all
  among the most recent denial's (rule id + reason, which names the target). Claude's retry is rarely byte-identical
  (it adds `&& git log`), so a text match would fail; a finding match still blocks anything that trips a new finding.
  10 minutes, one use, one project (the file lives in that project's `.veto/` and records its root).
- *Used up only when it changes the decision*, claimed by deleting `.veto/override.json`. `unlink` succeeds for one
  process only, so two hook calls running in parallel can't both use it.
- *Still never "allow".* An override removes findings; the call then gets no decision and Claude Code's own
  permission flow applies, as in watch mode.
- *Errors while reading an override keep the decision as it was* (logged to errors.log). This is the one place a Veto
  error doesn't mean "no decision": a broken override file must not turn a deny into a pass.
- *The agent can't grant itself an override.* New category `self-protection`: `veto allow`, `veto mode watch` and
  `veto uninstall` run through Bash, and Write/Edit/redirects into `.veto/`, are high. Not covered: scripts or other
  programs editing `.veto/` or `.claude/settings*.json` (README, "What Veto does not cover").

**Latency.** Same as before on Node 22.14 (interleaved, 200 runs, the pre-task build 82331ea vs this one, current
fixtures): Bash p95 33.7 vs 33.7 ms watch, 34.1 vs 34.4 ms guard; non-Bash 25.4 vs 25.3 ms. Absolute numbers are higher
than D3's 29.7 ms because new fixture 19 spawns a real `git status` (both builds pay it).
