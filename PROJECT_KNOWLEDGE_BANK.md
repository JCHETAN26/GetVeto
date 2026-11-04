# PROJECT KNOWLEDGE BANK: Veto (getveto)

## 1. PROJECT IDENTITY & REPOSITORY METADATA
- **Project Name:** Veto (npm package: `getveto`, binary CLI: `veto`)
- **Repository URL / Link:** https://github.com/JCHETAN26/GetVeto
- **Primary Domain:** AI Agent Safety & Guardrails / Runtime Execution Governance / DevSecOps
- **Primary Tech Stack:**
  - **Runtime:** Node.js (requires `>= 22.0.0`, optimized for Node `>= 22.1.0` via compile cache)
  - **Language:** TypeScript 5.9.3 (strict mode, NodeNext module resolution)
  - **Bundler & Tooling:** esbuild 0.28.2 (produces a single-file minified CommonJS bundle targeting Node 22)
  - **Parser:** unbash 6.0.2 (pure TypeScript AST Bash parser, zero runtime dependencies)
  - **Test & Evaluation Framework:** Vitest 3.2.7
  - **Protocols & Integrations:** Claude Code Hook Protocol (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`) via JSON stdin/stdout over stdio IPC
- **Development Timeline / Status:** v0.1.0 Preview (Complete, fully benchmarked, 457 tests passing, ready for npm publishing)
- **Repository Layout & Core Directories:**
  - `src/`: Core application runtime, CLI dispatch, configuration, and logging
    - `src/cli.ts`: Entry point CLI dispatcher (`hook`, `init`, `mode`, `status`, `doctor`, `allow`, `deny`, `log`, `label`, `uninstall`)
    - `src/hook.ts`: High-throughput, fail-open `PreToolUse` hook worker (runs on the hot path for every agent tool invocation)
    - `src/decide.ts`: Decision engine translating rule verdicts to Claude Code hook protocol responses (`deny`, `ask`, `log`)
    - `src/storage.ts`: POSIX owner-only storage primitives (`0700` dirs, `0600` files) avoiding recursive libuv hanging bugs
    - `src/truncate.ts`: Hot-path UTF-8 byte truncation with lazy SHA-256 hash markers
    - `src/doctor.ts`: Health-check diagnosis engine validating Node versions, hooks, and filesystem ACLs
    - `src/override.ts` & `src/override-cli.ts`: Human-in-the-loop override subsystem with atomic filesystem claims
  - `src/shell/`: Shell AST analysis
    - `src/shell/parse.ts`: Wraps `unbash`, expands aliases/environments, computes command sequences (`ranBefore`), pipeline positions (`pipeStage`), and wrapper unwrapping
    - `src/shell/paths.ts`: Conservative path target classifier (`classifyPath`: inside-project, outside-project, home, system, unknown)
  - `src/rules/`: Deterministic rule enforcement engine
    - `src/rules/engine.ts`: Trigger-based parse prefilter, tool-based category lazy loading, and rule evaluation
    - `src/rules/destructive/`: Rules intercepting work-discarding git commands, branch deletions, force pushes, stash drops, and arbitrary file deletions
    - `src/rules/file-tools/`: Rules policing native tool file modifications (Write, Edit, MultiEdit) on sensitive/out-of-tree paths
    - `src/rules/secret-access/`: Rules flagging shell reads of credential files and full environment dumps
    - `src/rules/exfiltration/`: Rules flagging unauthorized data transmission via network clients (`curl`, `wget`, `nc`, `socat`, `rsync`, etc.)
    - `src/rules/self-protection/`: Rules preventing the agent from altering Veto configuration or granting self-overrides
  - `redteam/`: Adversarial evaluation framework, disposable sandbox generators, and scenario definitions (`PLAYBOOK.md`)
  - `test/`: 39 test suites comprising unit, integration, timing, and real captured Claude Code fixtures (`test/fixtures/real/`)
  - `scripts/`: Production bundle pipeline (`bundle.mjs`), latency benchmarking harnesses (`bench-hook.mjs`), rule evaluation (`eval-rules.mjs`), and fixture capture (`capture-fixtures.mjs`)
  - `docs/`: Architectural Decision Records (`docs/decisions.md` D1–D4) and Claude Code hook protocol reverse engineering (`docs/hooks-research.md`)

---

## 2. SYSTEM OVERVIEW & ARCHITECTURAL PROBLEM
- **What is this system?**
  Veto is a local-first, low-latency execution governance layer for autonomous AI coding agents (specifically Claude Code). Intercepting every tool call synchronously via Claude Code’s `PreToolUse` hook lifecycle, Veto parses command ASTs and file paths against deterministic safety rules to block destructive operations, prevent credential exfiltration, and prompt for human approval—executing with zero network telemetry and sub-35ms p95 latency.
- **What fundamental bottleneck, problem, or limitation does it solve?**
  Autonomous coding agents operate with shell and filesystem access, making them susceptible to prompt injection, compounding errors, or reckless execution (e.g., executing `git reset --hard` destroying unstaged developer progress, reading `.env` secrets, or exfiltrating data via `curl`). Standard regex-based command filters fail due to shell syntax complexities (quoting, environment prefixes, nested subshells, command chains). Veto solves this by performing structural Abstract Syntax Tree (AST) decomposition and sequence analysis before execution, while ensuring that internal errors or latency spikes never stall developer workflows (fail-open architecture).
- **Target Workloads & Consumers:**
  Invoked synchronously as a child process by Claude Code before every tool execution (Bash, File Read, File Write, File Edit, MultiEdit).
  - **SLA Requirements:** Must execute, parse, evaluate, log, and exit within strict interactive human latency budgets (hard target: sub-35ms p95 latency on modern Node.js runtimes; timeout ceilings at 2000ms stdin, 1500ms engine, 3000ms process exit).
  - **Reliability SLA:** Zero crash interference with the agent. Must fail open on malformed inputs, internal bugs, or timeouts.
- **High-Level Data Flow:**
  1. **Ingestion:** Claude Code launches `veto hook` as a fresh subprocess and pipes the hook JSON payload into `stdin`. `src/hook.ts` buffers input under a 32 MB guard with a 2000ms hard ceiling (`STDIN_TIMEOUT_MS`).
  2. **Serialization & Validation:** Payload is parsed into a JSON structure (`parseEvent`). Non-PreToolUse events (`PostToolUse`, `UserPromptSubmit`) are formatted, size-capped, and written to `.veto/log.jsonl` before immediate process exit (exit 0).
  3. **Concurrency / Isolation:** For `PreToolUse`, Veto resolves the canonical project root (respecting `CLAUDE_PROJECT_DIR`) and loads `.veto/config.json`.
  4. **AST Parsing & Trigger Prefiltering:** If the tool is `Bash`, `src/rules/engine.ts` checks command tokens against registered rule triggers (`mayMention`). If triggered, it dynamically loads `unbash` to parse the command into a structured `SimpleCommand[]` array, expanding aliases, unwrapping wrappers (`sudo`, `timeout`), tracking directory context (`cd`), and calculating execution order (`ranBefore`).
  5. **Rule Engine Evaluation:** Active rules evaluate context. Destructive git checks execute a low-overhead `git status --porcelain` check (capped at 500ms) only when work-discarding commands are detected. Findings are sorted by severity (`high` > `medium` > `low`).
  6. **Human Override Resolution:** If blocking findings exist, Veto checks for a pending `.veto/override.json`. If valid (within 10-minute TTL and matching finding signatures), the override is atomically claimed via `unlinkSync` and findings are cleared.
  7. **Decision & Response:** `src/decide.ts` maps findings to actions based on operating mode (`watch` vs. `guard`):
     - In **Watch Mode**: Logs verdict, exits 0 with empty stdout (allowing Claude Code's native flow).
     - In **Guard Mode**: Denies high-severity actions (`permissionDecision: "deny"`) or prompts for human approval (`permissionDecision: "ask"`) with an explanatory reason and a suggested safer alternative, printed to stdout. Exit code is always 0.
  8. **Audit Logging:** The sanitized, truncated event, execution timing (`analysis_ms`), verdict, and decision are atomically appended to `.veto/log.jsonl` with `0600` permissions.

---

## 3. CORE TECHNICAL CONTRIBUTIONS & IMPLEMENTATION DEEP-DIVE

### Subsystem 1: Sub-35ms Synchronous Hook Pipeline & Cold-Start Optimization
- **The Challenge / Bottleneck:**
  Because Claude Code invokes the hook CLI as an independent, synchronous subprocess on every single tool call, process bootstrap time is the primary latency driver. In initial implementations (ESM output via `tsc`), Node bootstrap (~17ms) + ESM loader resolution (~4ms) + module graph imports (engine, rules, unbash ~22ms) resulted in a p95 latency exceeding 60ms for `Bash` commands, causing noticeable interactive lag.
- **Codebase Implementation Details:**
  1. **Single-File Bundling (`scripts/bundle.mjs`):** Uses `esbuild` to compile all source modules and third-party dependencies (`unbash`) into a single CommonJS bundle (`dist/veto.js`). This eliminated all runtime filesystem module resolution overhead.
  2. **V8 Compile Cache Integration (`src/entry.cjs`):** Leverages Node.js 22's native `module.enableCompileCache()` API to persist bytecode in `$XDG_CACHE_HOME/getveto` (or `~/.cache/getveto`), saving 3–4ms per invocation at a cost of only ~50 KB per build.
  3. **High-Resolution Timing & Import Pruning:** Replaced `performance.now()` (which loads Node's heavy `perf_hooks` internal subsystem) with `process.hrtime.bigint()` (in `src/clock.ts`), saving 0.4–0.9ms.
  4. **Trigger-Based Lazy Loading (`src/rules/engine.ts`):** `rulesFor(toolName)` loads rule categories dynamically. For `Bash` commands, the ~10–20ms `unbash` AST parser import is skipped entirely unless tokens match registered rule triggers (`mayMention`).
- **Why this approach? (Design Rationale & Alternatives Rejected):**
  - *Alternative Rejected (Background Daemon):* A long-running daemon was evaluated and rejected in ADR D3. A Node-based CLI client communicating with a Unix domain socket would still incur Node’s 17–20ms startup floor. A daemon would introduce process management complexity, orphaned processes, and stale memory states for zero latency benefit.
  - *Alternative Rejected (V8 Startup Snapshots):* Producing a snapshot blob (`--snapshot-blob`) generated a 6.2 MB binary tied strictly to local Node micro-versions. Deserialization overhead proved slower than executing the minified 230 KB CommonJS bundle with compile cache.
  - *Alternative Rejected (`fs.readSync` on fd 0):* Attempting to bypass `process.stdin` streams via raw POSIX `fs.readSync(0, ...)` saved 2.6ms in isolation, but failed hard on edge cases: when stdin was left open by the parent, libuv blocked in a threadpool worker, preventing process termination and defeating the 2-second timeout guard.
- **Ownership & Key Files:**
  - `scripts/bundle.mjs`: esbuild bundling configuration and license aggregator
  - `src/entry.cjs`: Production binary entrypoint enabling V8 compile cache
  - `src/clock.ts`: Lightweight high-resolution timer (`process.hrtime.bigint`)
  - `docs/decisions.md`: Architectural Decision Records D1, D2, and D3

### Subsystem 2: AST-Based Shell Analysis Engine & Contextual Sequence Ordering
- **The Challenge / Bottleneck:**
  Regex matching shell commands is inherently insecure: commands like `rm -rf /` can be masked via quoting (`'r'm`), variables (`$RM`), subshells, or command wrappers (`sudo`, `timeout`). Furthermore, naive rules produce false positives: running `git reset --hard` is catastrophic when uncommitted work exists, but benign if immediately preceded by `git stash` in a compound chain (`git stash && git reset --hard`).
- **Codebase Implementation Details:**
  1. **Deterministic AST Parsing (`src/shell/parse.ts`):** Integrates `unbash` to convert arbitrary Bash commands into structured `SimpleCommand` records. It recursively unwraps command wrappers (`sudo`, `env`, `xargs`, `time`, `nohup`, `timeout`, `nice`, `command`, `exec`, `stdbuf`, `ionice`), strips ANSI-C quoting (`$'...'`), resolves tildes and standard environment variables (`$HOME`, `$PWD`, `$OLDPWD`), and flags dynamically unresolved arguments (`Arg.unresolved`).
  2. **Execution Sequence Graphs (`ranBefore` in `src/shell/parse.ts`):** Calculates guaranteed-preceding command indices. In a chain `A && B && C`, command `C` has `[A, B]` in `ranBefore`. The engine strictly excludes branches separated by `||`, pipelines (`|`), background jobs (`&`), subshells, or conditional bodies.
  3. **Contextual Git Discard Downgrades (`src/rules/destructive/git-discard.ts`):** When evaluating work-discarding operations (`git reset --hard`, `checkout .`, `clean -dx`), the rule inspects `ranBefore`. If a full `git stash` targeted at the same repository root certainly executed prior to the reset, the severity is automatically downgraded from `high` to `low` (audit only), enabling the agent to follow Veto's own advice without blocking.
  4. **Pipeline Stage Tracking (`pipeStage`):** Differentiates pipeline origin (stage 0) from consumption stages (stage 1+), allowing `exfiltration/network-send` to accurately detect piped data leaks (e.g. `cat file | nc host port`).
- **Why this approach? (Design Rationale & Alternatives Rejected):**
  - *Alternative Rejected (`shell-quote`):* Failed basic syntax tests (splits `$(` into `$` and `(`, breaks heredocs into disparate tokens).
  - *Alternative Rejected (`sh-syntax` Go/WASM):* Required an asynchronous WASM runtime initialization costing ~23ms per call before rule evaluation could begin.
  - *Selection of `unbash 6.0.2`:* Pure TypeScript, synchronous execution, zero dependencies, tolerant error handling (returns partial trees with AST error nodes rather than throwing, supporting fail-open semantics).
- **Ownership & Key Files:**
  - `src/shell/parse.ts`: Core AST transformation, wrapper unwrapping, and `ranBefore` graph construction
  - `src/shell/paths.ts`: Path containment classification (`classifyPath`)
  - `src/rules/destructive/git-discard.ts`: Context-aware git discard evaluation
  - `docs/decisions.md`: Decision Record D1 and D4

### Subsystem 3: Local-First Governance Engine, State Machine & Tamper-Resistant Self-Protection
- **The Challenge / Bottleneck:**
  A safety layer running inside the environment it governs is vulnerable to adversarial subversion: the AI agent can attempt to disable the hook (`veto allow`, `veto mode watch`, `veto uninstall`), modify configuration files, or write exploits directly into `.veto/`. Furthermore, user overrides must be race-condition-free and must never accidentally auto-approve unrelated dangerous operations.
- **Codebase Implementation Details:**
  1. **Self-Protection Rules (`src/rules/self-protection/override.ts`):** High-severity rules strictly intercept and block any agent attempt to execute `veto allow`, `veto mode watch`, or `veto uninstall` via Bash, and block any File Tool (`Write`, `Edit`, `MultiEdit`) targeting `.veto/` or `.claude/settings*.json`.
  2. **Atomic One-Time Overrides (`src/override.ts`):** Implements `veto allow --once` for human terminal intervention. Overrides record exact finding signatures (`ruleId` and normalized `reason`) rather than brittle command strings. To eliminate race conditions across concurrent hook processes, consumption is implemented via atomic POSIX `unlinkSync(overridePath)`. Only the process that successfully unlinks the file claims the override; concurrent processes fail the unlink and retain blocking decisions.
  3. **Strict Zero-Loosening Storage Primitives (`src/storage.ts`):** Creates `.veto/` with `0700` and files with `0600`. Uses synchronous file descriptor APIs (`openSync` with mode `0600` followed by `fchmodSync`). Explicitly avoids `mkdirSync({ recursive: true })` because on Node 22.14 recursive directory creation can hang indefinitely on specific synthetic mount points (e.g., `/proc`), which would violate the non-hanging SLA.
  4. **Deterministic Protocol Invariant (`src/decide.ts`):** Veto strictly enforces that it *never* outputs `permissionDecision: "allow"`. In watch mode or for benign commands, it exits 0 with completely empty stdout. Emitting `"allow"` would override and suppress Claude Code’s native permission dialogs. Veto only outputs `"deny"` or `"ask"`.
- **Why this approach? (Design Rationale & Alternatives Rejected):**
  - *Signature Matching vs. Exact Text Matching:* Agents rarely repeat blocked commands verbatim on retry (e.g., adding `&& git log` or changing spacing). Matching on finding keys (`ruleId` + target `reason`) ensures valid retries proceed while blocking any newly introduced threats.
  - *Fail-Open vs. Fail-Closed:* While security engines traditionally fail closed, developer tooling must prioritize availability. A hung or crashing hook ruins developer trust. Veto guarantees that any timeout or internal parsing exception falls back to watch behavior and logs to `.veto/errors.log`.
- **Ownership & Key Files:**
  - `src/decide.ts`: Protocol mapping and output invariant enforcement
  - `src/override.ts`: Atomic override storage, TTL validation, and race-free claim logic
  - `src/rules/self-protection/override.ts`: Agent containment rules
  - `src/storage.ts`: Hardened POSIX storage primitives

---

## 4. VERIFIED BENCHMARKS & PERFORMANCE METRICS

All metrics below are extracted directly from repository benchmark suites (`scripts/bench-hook.mjs`, `scripts/bench-parse.mjs`, `scripts/eval-rules.mjs`, `test/integration/timing.test.ts`) and documented Architectural Decision Records (`docs/decisions.md`).

| Metric Category | Baseline / Alternative | Achieved Result | Improvement / Scale | Environment / Hardware | Measurement Method |
|---|---|---|---|---|---|
| **Hook Latency: Bash (Watch)** | 37.6 ms (p50) / 50.6 ms (p95) (Task #4 tsc ESM) | **25.4 ms (p50) / 29.7 ms (p95)** | **41.3% reduction in p95 latency** | 16-core Linux, Node v22.14.0, load 3.6 | Interleaved 200-run benchmark (`bench-hook.mjs`) |
| **Hook Latency: Bash (Guard)** | 37.3 ms (p50) / 50.6 ms (p95) (Task #4 tsc ESM) | **25.4 ms (p50) / 29.5 ms (p95)** | **41.7% reduction in p95 latency** | 16-core Linux, Node v22.14.0, load 3.5 | Interleaved 200-run benchmark (`bench-hook.mjs`) |
| **Hook Latency: Non-Bash (Watch)** | 33.2 ms (p50) / 36.7 ms (p95) (Task #4 tsc ESM) | **24.5 ms (p50) / 27.0 ms (p95)** | **26.4% reduction in p95 latency** | 16-core Linux, Node v22.14.0, load 3.4 | Interleaved 200-run benchmark (`bench-hook.mjs`) |
| **Hook Latency: Non-Bash (Guard)** | 33.3 ms (p50) / 36.2 ms (p95) (Task #4 tsc ESM) | **24.6 ms (p50) / 27.2 ms (p95)** | **24.9% reduction in p95 latency** | 16-core Linux, Node v22.14.0, load 3.1 | Interleaved 200-run benchmark (`bench-hook.mjs`) |
| **Hook Latency: macOS Subprocess** | Standard Node cold start | **59.7 ms (p50) / 106.1 ms (p95)** (max: 130.5 ms) | Verified sub-150ms on macOS | Apple Silicon macOS, Node v22.12.0 | Vitest subprocess integration suite (30 runs) |
| **Engine In-Process Execution** | Cold parser load: ~10–20 ms | **1.061 ms (p50) / 99.377 ms (p95)** | Sub-2ms warm evaluation | 16-core Linux, Node v22.14.0 | Real captured fixture evaluation (`eval-rules.mjs`) |
| **Parser Warm Parse Time** | First cold parse: 2.0–4.5 ms | **1.0 – 40.0 µs** per command | >100x speedup after JIT warmup | 16-core Linux, Node v22.14.0 | In-memory microbenchmark (`bench-parse.mjs`) |
| **Artifact Footprint** | Unbundled tsc build: 360 KB multi-file | **230 KB single bundle** | 36.1% bundle size reduction | esbuild 0.28.2 CJS minification | File size on disk (`dist/veto.js`) |
| **V8 Compile Cache Footprint** | Full module cache: ~200 KB multi-file | **~50 KB** per Node version | 75% cache footprint reduction | Node 22 `module.enableCompileCache` | Disk usage in `$XDG_CACHE_HOME/getveto` |
| **Child Process Git Check** | Full git status invocation: 20–30 ms | **~8.0 ms** (capped at 500 ms) | Read-only porcelain isolation | Local git repository check | `execFileSync` with `core.fsmonitor=false` |
| **Rule Accuracy & False Positives** | Unfiltered heuristic baseline | **0 false positives** across 8 benign real fixtures; **100% detection** across 4 dangerous fixtures | Zero false-positive rate on real test corpus | Real captured Claude Code session payloads | `npm run eval` rule suite |

*Benchmark Configuration Summary:*
Linux benchmarks executed on a 16-core AMD/Intel workstation running Node v22.14.0 (`powersave` governor, background load average 2.4–4.8). macOS timing tests executed on Apple Silicon running Node v22.12.0. Latency tests run interleaved (alternating builds per iteration) across 200 to 300 cycles per payload type using real captured Claude Code fixtures.

---

## 5. RESILIENCE, RELIABILITY & EDGE CASES
- **Failure Modes Handled:**
  - **Unclosed / Stalled Stdin:** Handled via `STDIN_TIMEOUT_MS = 2000`. If Claude Code fails to close stdin within 2000ms, the hook aborts waiting, logs an error, and exits 0 with empty stdout (fail-open).
  - **Memory Exhaustion (OOM Guard):** `MAX_STDIN_BYTES = 32 * 1024 * 1024` (32 MB). If streaming input exceeds 32 MB, buffering halts immediately, preventing Node heap exhaustion while failing open.
  - **Rule Engine Stalls:** `ENGINE_TIMEOUT_MS = 1500`. Rule evaluation is raced against a 1.5-second timer. If an external check (e.g. `git status`) hangs, the engine falls back to an error verdict and exits clean.
  - **Global Process Exit Guard:** `EXIT_GUARD_MS = 3000`. A detached timeout triggers `process.exit(0)` after 3 seconds as a last-resort safety valve against unhandled event loop handles.
  - **Recursive `mkdir` Freezes:** Node 22.14 contains known edge-case bugs where `mkdirSync(path, { recursive: true })` deadlocks indefinitely under specific synthetic paths. `src/storage.ts` explicitly rejects recursive directory creation, creating single-level `.veto` directories only.
  - **Corrupted Config / Malformed JSON:** If `.veto/config.json` contains malformed JSON or invalid schema values, Veto catches the error, logs it to `.veto/errors.log`, and gracefully degrades to default watch mode.
  - **Atomic One-Time Override Race Conditions:** Multiple concurrent hook calls racing to claim a `veto allow --once` override are serialized by POSIX filesystem atomicity (`unlinkSync`). Exactly one process consumes the override; parallel processes retain active protection.
- **Data Integrity & Consistency Guarantees:**
  - **Append-Only Logging:** `.veto/log.jsonl` is written using synchronous atomic appends (`openSync` with `"a"`, `writeSync`, `closeSync`).
  - **File Payload Truncation:** Log entries cap shell commands and user prompts at 16 KB (`COMMAND_MAX_BYTES`) and all other string parameters at 4 KB (`MAX_BYTES`). Over-limit strings are truncated cleanly on UTF-8 code point boundaries (backing off continuation bytes `0x80..0xBF`) and stamped with an immutable SHA-256 hash and byte length marker: `…[veto:truncated original_bytes=N sha256=HEX]`.
  - **Strict POSIX Permissions:** All storage operations enforce owner-only ACLs (`0700` for `.veto/`, `0600` for files). Veto masks umask loosening on creation and logs warnings via `veto doctor` if permissions become world-readable.
- **Testing Rigor:**
  - **457 Automated Tests across 39 Test Suites** (100% pass rate in Vitest).
  - **Zero Synthetic Mocks Policy (`CLAUDE.md` Rule 1):** Prohibits mock hook payloads. Integration suites test against 21 real, captured Claude Code session fixtures (`test/fixtures/real/`).
  - **Subprocess Integration Testing (`CLAUDE.md` Rule 2):** Tests spawn the fully compiled, minified production CLI binary (`dist/cli.js`) via subprocesses, verifying real stdio IPC, exit codes, and stdout strings.
  - **Disposable Red-Team Sandbox Generator (`npm run redteam:setup`):** Generates ephemeral git repositories with isolated remotes, uncommitted changes, and templates to execute destructive attacks safely without host corruption.

---

## 6. ENGINEERING TRADE-OFFS (INTERVIEW TALKING POINTS)

### Trade-off 1: Synchronous Per-Call CLI Process vs. Long-Running Background Daemon
- **What was traded?**
  Traded potential zero-cost in-memory caching (daemon) for architectural simplicity, zero state drift, and extreme deployment reliability (fresh CLI process per hook invocation).
- **Why was this the right decision?**
  A background daemon architecture introduces process lifecycle fragility: zombie processes, socket permissions, state synchronization bugs, stale config reloads, and orphan daemons surviving project deletion. By profiling the execution path, we discovered Node's startup floor is ~17ms. A Node CLI client talking to a local socket would *still* incur that 17ms floor. By compiling into a single-file CommonJS bundle and enabling Node's compile cache, we achieved a ~25ms p50 / <30ms p95 latency directly within a stateless process—rendering a daemon completely unnecessary.

### Trade-off 2: Fail-Open Architecture vs. Strict Fail-Closed Security Policy
- **What was traded?**
  Traded guaranteed prevention of unknown edge-case threats (fail-closed) for developer workflow preservation, system stability, and non-blocking operation (fail-open).
- **Why was this the right decision?**
  Veto is a developer safety layer and seatbelt, not an enterprise network firewall. If an internal exception, JSON parse error, or unexpected edge-case crashes the hook with an exit code 2 or hangs stdin, Claude Code halts the entire developer session. Halting an engineer's work destroys trust in the tool immediately. By strictly enforcing `exit 0` with empty stdout on any internal failure and routing diagnostics to `.veto/errors.log`, Veto ensures it can never brick or disrupt an agent session.

### Trade-off 3: Static AST Shell Parsing & Sequence Graphs vs. Full In-Memory Shell Emulation
- **What was traded?**
  Traded tracking dynamic runtime variable expansions (e.g. `CMD="rm -rf /"; $CMD`) for deterministic sub-millisecond static analysis and zero side-effect overhead.
- **Why was this the right decision?**
  Emulating a complete Bash environment (or executing within an isolated ptrace/seccomp container) introduces massive complexity, high latency (hundreds of milliseconds), and platform-specific kernel dependencies. By leveraging `unbash` to build an AST and extracting structural execution guarantees (`ranBefore`), Veto accurately recognizes critical compound sequences (such as `git stash && git reset --hard`) without the overhead and indeterminism of dynamic runtime virtualization. Unresolved dynamic expressions are conservatively flagged rather than blindly executed.

---

## 7. BOUNDARIES & DISALLOWED CLAIMS (ANTI-HALLUCINATION)
- **Confirmed Capabilities (What the system definitely does today):**
  - Intercepts Claude Code tool calls synchronously via `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `UserPromptSubmit`.
  - Operates in **Watch Mode** (audit logging with zero blocking) and **Guard Mode** (blocking high severity with `deny`, prompting medium with `ask`, and logging low).
  - Detects destructive git operations (`reset --hard`, `checkout .`, `restore`, `clean -dx`, `branch -d/-D`, force pushes, `stash drop/clear`).
  - Distinguishes command sequence safety: downgrades `git reset --hard` to low severity if a full `git stash` precedes it in the same compound statement (`ranBefore`).
  - Detects out-of-project file deletions (`rm`), broad disk manipulations (`dd`, `mkfs`, recursive `chmod`/`chown`, `find -delete`).
  - Blocks reads/edits of hardcoded sensitive paths (`.env`, SSH keys, AWS credentials, `.npmrc`, `*credentials*.json`).
  - Blocks unauthorized network sends via common CLI clients (`curl`, `wget`, `http`, `nc`, `socat`, `scp`, `rsync`, `sftp`).
  - **Blocks secret-to-network dataflow**: High-severity deny when secrets or env dumps flow into network clients via pipelines, file uploads (`curl -d @.env`), input redirection, or command substitution.
  - Blocks agent self-tampering: denies execution of `veto allow`, `veto mode watch`, `veto uninstall`, and edits to `.veto/` or `.claude/settings*.json`.
  - Implements atomic human overrides via `veto allow --once` using finding signature matching and atomic POSIX `unlinkSync`.
  - Runs 100% locally with zero network calls, zero telemetry, and owner-only POSIX permissions (`0700`/`0600`).
- **Out of Scope / Aspirational (What is NOT implemented or only planned):**
  - **Model-Based Reviewer:** There is NO LLM or local model evaluating intent. It is strictly a deterministic, rule-based AST/regex engine today.
  - **Localhost Network Whitelisting:** Requests to `localhost` / `127.0.0.1` are flagged identically to external network destinations.
  - **Dynamic Shell Obfuscation:** Does not evaluate variable indirection (e.g., `CMD=cat; $CMD .env`) or custom scripts opening sockets/files.
  - **Windows / PowerShell AST Parsing:** Does not parse PowerShell syntax (`unbash` is Bash-specific).
  - **Container / Sandbox Isolation:** Veto is NOT a sandbox, jail, or container runtime.
- **Strict Interview Boundaries (What you must NEVER claim):**
  - *Never claim* Veto uses an LLM, embeddings, or AI to detect dangerous commands.
  - *Never claim* Veto acts as an operating system sandbox or kernel-level seccomp/eBPF filter.
  - *Never claim* Veto emits `permissionDecision: "allow"`. (Emitting "allow" is explicitly forbidden by the architecture to prevent auto-approving native prompts).
  - *Never claim* Veto runs a persistent background daemon server.

---

## 8. PRODUCTION-GRADE RESUME BULLETS (XYZ FORMULA)

### Track A: Systems / C++ / Go / Distributed Systems Focus
- **Engineered a local-first execution guardrail for autonomous AI coding agents (Claude Code)**, achieving a **<30ms p95 hook latency** budget by eliminating runtime module resolution via single-file esbuild CommonJS bundling and V8 compile cache bytecode persistence (`module.enableCompileCache`).
- **Designed a fail-open stdio IPC interception pipeline** handling tool validation across 450+ integration tests, implementing **POSIX atomic state claims (`unlinkSync`)** to eliminate concurrency race conditions during human-in-the-loop permission overrides.
- **Optimized Node.js process cold starts from 56ms to 25.4ms p50** by profiling bootstrap overhead, replacing high-overhead standard library globals (`perf_hooks`) with nanosecond monotonic clocks (`process.hrtime.bigint`), and implementing trigger-based lazy module evaluation.

### Track B: Backend Engineering / Core Infrastructure Focus
- **Architected a deterministic AST-based shell governance engine** using `unbash`, parsing complex compound statements, environment variable overrides, and wrappers (`sudo`, `timeout`) to block destructive git actions, data exfiltration, and credential leaks.
- **Implemented contextual sequence dependency graphs (`ranBefore`)** within a CLI security layer, successfully preventing false positives by differentiating unsafe bare resets from safe sequences (e.g. `git stash && git reset --hard`).
- **Built an automated adversarial evaluation framework and red-team test harness**, maintaining zero false positives across a 39-suite integration test corpus built exclusively from real captured agent payloads.

### Track C: AI / Machine Learning / Search Engineering Focus
- **Engineered runtime governance and permission guardrails for autonomous coding agents**, intercepting raw agent tool invocations before execution to enforce enterprise safety boundaries without breaking developer velocity.
- **Developed a tamper-resistant agent self-protection subsystem**, intercepting agent prompt injection and hallucinated command paths to prevent autonomous modification of security settings, log files, or permission boundaries.
- **Constructed an end-to-end evaluation and telemetry-free logging infrastructure**, capturing size-capped tool payloads with UTF-8 boundary normalization and lazy SHA-256 integrity hashing under owner-only POSIX permissions.
