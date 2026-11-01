# Claude Code hooks: research notes for Veto

Researched 2026-10-31 against the official docs. Local Claude Code version: `2.1.316`.
Everything below comes from the docs pages listed at the bottom. **Nothing here has been checked against a real
captured payload yet.** That happens in Task #1 Step 3, and this file must be updated if the real payloads differ.

Anything the docs leave open is marked **UNCLEAR**.

---

## 1. Which events fire around a tool call

| Event | When it fires | Can it block? |
|---|---|---|
| `PreToolUse` | "Before a tool call executes. Can block it." Runs after Claude has built the tool parameters and before the call is processed. | **Yes** |
| `PermissionRequest` | "When a tool call needs a permission decision" (that is, a permission dialog would appear). | Only through its own `decision` object; exit 2 is **not** honored here |
| `PostToolUse` | "After a tool call succeeds." | No (the tool already ran). It can add feedback for Claude or replace the output Claude sees. |
| `PostToolUseFailure` | "After a tool call fails." Does **not** fire for calls rejected before they run (unknown tool, schema failure, permission denial). | No |
| `PermissionDenied`, `PostToolBatch` | Also exist. Not needed for Task #1. | — |

Coverage gaps the docs state outright, which matter for Veto later:

- `PreToolUse` fires only when Claude **calls a tool**. A file the user `@`-mentions in a prompt is inlined without a
  tool call, so **no hook fires** for it, not even one matching `Read`.
- `PreToolUse` never fires for `EndConversation`.
- It does fire inside subagents. Those payloads also carry `agent_id` and `agent_type`.

**Veto decision for Task #1:** register on `PreToolUse` (the future blocking point) and on `PostToolUse` plus
`PostToolUseFailure` (so the log records outcomes), all with matcher `"*"`.

## 2. Input JSON on stdin

Hooks get one JSON object on stdin.

### Common fields (every event)

| Field | Notes |
|---|---|
| `session_id` | Current session id |
| `prompt_id` | UUID of the user prompt being processed. "Absent until the first user input." |
| `transcript_path` | Path to the conversation JSONL. It is written asynchronously and can lag behind the live conversation. |
| `cwd` | Current working directory when the hook is invoked. It follows Claude (for example into worktrees). |
| `scratchpad_dir` | Session scratchpad path. Can be absent. Requires v2.1.257 or later. |
| `permission_mode` | `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`. "Not all events receive this field." |
| `effort` | `{ "level": "low"\|"medium"\|"high"\|"xhigh"\|"max" }`. Present on PreToolUse and PostToolUse "on models with effort". |
| `hook_event_name` | e.g. `"PreToolUse"` |
| `agent_id`, `agent_type` | Only present inside a subagent, a teammate, or a session started with `--agent`. |

### PreToolUse-specific fields
`tool_name`, `tool_input`, `tool_use_id`. MCP tools also carry `mcp_server: { name, source }` (v2.1.274 or later).

Docs example, copied verbatim (**a docs example, not a real capture**):

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "scratchpad_dir": "/tmp/claude-1000/-home-user-my-project/abc123/scratchpad",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run test suite",
    "timeout": 120000,
    "run_in_background": false
  },
  "tool_use_id": "toolu_01ABC123..."
}
```

`tool_input` shapes from the docs (these are what `veto log` summarizes):

| Tool | Fields |
|---|---|
| Bash / PowerShell | `command`, `description?`, `timeout?`, `run_in_background?` |
| Write | `file_path` (always absolute), `content` |
| Edit | `file_path` (always absolute), `old_string`, `new_string`, `replace_all?` |
| Read | `file_path` (always absolute), `offset?`, `limit?` |
| Glob | `pattern`, `path?` |
| Grep | `pattern`, `path?`, `glob?`, `output_mode?`, `-i?`, `multiline?` |
| WebFetch | `url`, `prompt`, `offset?` |
| WebSearch | `query`, `allowed_domains?`, `blocked_domains?`, `mode?` |
| Agent | `prompt`, `description`, `subagent_type`, `model?` |

The docs say file paths are expanded (`~` and relative paths) **before** hooks run, so path checks can't be bypassed
with another spelling of the same path. On Windows, paths arrive with backslashes.

### PostToolUse-specific fields
Everything PreToolUse gets, plus `tool_response` (shape depends on the tool) and `duration_ms`.
Docs example (**a docs example, not a real capture**; it has no `prompt_id` or `effort`, unlike the PreToolUse example):

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "file content" },
  "tool_response": { "filePath": "/path/to/file.txt", "type": "create" },
  "tool_use_id": "toolu_01ABC123...",
  "duration_ms": 12
}
```

### PostToolUseFailure-specific fields
`tool_name`, `tool_input` (plus `tool_use_id` per the common pattern; **UNCLEAR**, since the docs table doesn't list it
for this event), `error` (string whose format depends on the tool; the first line looks like `Exit code N`),
`is_interrupt` (bool), and `duration_ms`.

**UNCLEAR:** the docs warn that the field set varies by version and by event ("Not all events receive this field").
Veto must treat **every** field as optional and log the raw object as-is, never a re-shaped copy.

## 3. How a hook allows, blocks, or asks

### Exit codes
| Exit | Meaning |
|---|---|
| `0` | Success. If stdout is **exactly one JSON object** (whitespace allowed around it), its fields apply. Otherwise stdout is treated as plain text and, for PreToolUse, only goes to the debug log. Claude never sees stderr from an exit-0 hook. |
| `2` | **Blocking error.** On PreToolUse the tool call is blocked and **stderr becomes the reason Claude sees**. JSON on stdout can't override the block, not even `"allow"`. |
| anything else | **Non-blocking error.** The action goes ahead and the user sees a `PreToolUse:<Tool> hook error` notice in the transcript. Exit 1 without valid JSON does **not** block. |

Valid JSON on stdout with a non-0, non-2 exit code counts as success (the JSON decides), unless `onFailure: "block"` is set.

### JSON decision for PreToolUse (exit 0, JSON on stdout)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask | defer",
    "permissionDecisionReason": "...",
    "updatedInput": { },
    "additionalContext": "..."
  }
}
```
- `"allow"`: **skips the permission prompt**, apart from a few actions no mode auto-approves. Deny and ask rules from
  settings are still evaluated.
- `"deny"`: blocks the call. `permissionDecisionReason` **is shown to Claude**.
- `"ask"`: shows the user a permission prompt, labelled `[settings]` for a settings-file hook. The reason is shown to the user.
- `"defer"`: only in `-p` (non-interactive) mode.
- When several hooks disagree: `deny` > `defer` > `ask` > `allow`.
- Top-level `decision: "approve"|"block"` is **deprecated** for PreToolUse.
- Universal fields: `continue: false` (stops Claude entirely), `stopReason`, `systemMessage` (a warning shown to the
  user), and `suppressOutput` ("has no effect").
- `additionalContext`, `systemMessage`, and plain stdout are each capped at 10,000 chars.

### What Claude sees when blocked
- Exit 2: the tool error reads `PreToolUse:Bash hook error: [<hook command>]: <stderr text>`.
- JSON deny: Claude gets `permissionDecisionReason`.

### ⚠️ Important for Veto's "observe-only" mode
Returning `permissionDecision: "allow"` is **not** a neutral choice. It **auto-approves** the tool call and skips the
prompt the user would otherwise see, which makes the user *less* safe. The docs' own example uses
`exit 0  # No decision: the normal permission flow applies`.
**So Veto's "allow" result in Task #1 is: exit 0 with empty stdout.** That records the call and leaves Claude Code's
normal permission flow exactly as it was. Whenever this codebase says "fail open / allow", it means this no-decision
exit 0 and never `permissionDecision: "allow"`.

## 4. Where the config lives

| File | Scope | Notes |
|---|---|---|
| `~/.claude/settings.json` | User, every project | **Veto never touches this.** |
| `.claude/settings.json` | Project, shared | Meant to be committed. Teammates get the hook too. |
| `.claude/settings.local.json` | Project, personal | Kept out of git. When Claude Code creates this file itself it adds it to the *global* git excludes; a file created by hand must be gitignored by hand. Note: since v2.1.211, if Claude starts in a subdirectory of a git repo, this file is read from the **repo root**. |
| Managed policy | Org-wide | Can set `allowManagedHooksOnly`, which blocks project hooks. |

Hooks **merge** across files rather than override. "If you define the same handler in more than one settings file,
it runs once." Settings files are strict JSON (no comments, no trailing commas). Claude Code **watches settings files
and reloads hooks** mid-session.

Format:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "veto", "args": ["hook"], "timeout": 10 }
        ]
      }
    ]
  }
}
```
Handler fields for `type: "command"`: `command`, `args` (present means exec form: spawned directly with no shell, and
`command` is looked up on `PATH`), `async`, `asyncRewake`, `shell` (`bash`/`powershell`), `onFailure`
(`continue`/`block`, v2.1.295 or later), plus the common fields `if`, `timeout` (seconds), and `statusMessage`.
Without `args`, shell form runs `sh -c` on macOS/Linux.

Matchers:
- `"*"`, `""`, or omitted: match everything.
- Only letters, digits, `_`, `-`, spaces, `,`, `|`: an exact name or a list (`Edit|Write`, `Edit, Write`).
- Anything else: an unanchored JS regex (`mcp__memory__.*`). `Edit.*` also matches `NotebookEdit`.

Env vars given to the hook: `CLAUDE_PROJECT_DIR` (the project root where the session started; it **stays put** even
when `cwd` moves), `CLAUDE_EFFORT`, `CLAUDE_CODE_REMOTE`. The hook runs in Claude's current directory, with Claude
Code's environment, in its own session with no TTY.

**Workspace trust:** in an *interactive* session, Claude Code holds back every settings-file hook until the user has
accepted the trust dialog for the folder. In `-p` or SDK sessions, the folder counts as trusted automatically.
→ During the demo, the founder must accept the trust prompt in the sandbox.

**Veto decisions (for founder sign-off):**
- Use **exec form** (`"command": "veto", "args": ["hook"]`). That avoids shell quoting and sidesteps paths with spaces
  (this repo is on `/media/.../Extreme SSD2/`).
- Find "our" entries by `command === "veto"` plus `args[0] === "hook"`. That keeps `init` idempotent and lets
  `uninstall` remove only Veto's entries.
- Log to `$CLAUDE_PROJECT_DIR/.veto/` and fall back to `cwd` only when it is unset. `cwd` alone would scatter logs into
  subdirectories and worktrees.

## 5. Timeouts, hangs, and crashes

- Default `timeout` for command hooks is **600 s** (30 s on UserPromptSubmit and the model-switch events).
  → Veto will set **`"timeout": 10`** so a hung Veto can stall Claude for at most 10 s, not 10 minutes.
- On timeout, Claude Code cancels the hook and discards its output. **On PreToolUse a timed-out hook does NOT block**:
  the call continues through the normal permission flow.
- Crash, missing binary, or exit code other than 0/2: a non-blocking error. The action goes ahead and the user sees a
  `hook error` notice.
  → So if `veto` isn't on PATH (for example a teammate without Veto installed and a committed `.claude/settings.json`),
  every tool call shows an error notice, but nothing breaks.
- `onFailure: "block"` turns failures into blocks. **Veto must NOT set it.** That matches the fail-open rule.
- A hook that starts a background process without redirecting its stdout/stderr gets its tool call **blocked**
  ("refusing to honor the suspect capture"). Veto must not leave detached children holding stdout.
- Hooks for one event run **in parallel**, so two concurrent tool calls (subagents) can append to the log at the same time.
  Veto writes each entry as a single `appendFileSync` of one line with `O_APPEND`. **UNCLEAR:** atomicity of large
  appends (>PIPE_BUF / 4 KiB) on every filesystem. POSIX guarantees append-positioning, not atomic interleaving of
  very large writes.
- Debugging: `claude --debug-file <path>`, or `claude --debug` with the log at `~/.claude/debug/<session-id>.txt`.
  `/hooks` shows the configured hooks read-only.

## 5b. First real-session check (2026-10-31, Claude Code 2.1.316, Linux)

One `claude -p "Read notes.md ... Then run ls." --allowedTools Read "Bash(ls)"` run in a sandbox with `veto init`.
Observed 4 hook calls: PreToolUse Read, PreToolUse Bash (same second, so the hooks ran in parallel), then PostToolUse
for each. No errors. Field names seen:

- Common: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort.level`, `hook_event_name`,
  `tool_name`, `tool_input`, `tool_use_id`. **`scratchpad_dir` was absent** (the docs allow that).
- Read `tool_input`: `file_path`, `limit`. Bash `tool_input`: `command`, `description`.
- PostToolUse adds `duration_ms` and `tool_response`. Read's response is `{type, file: {filePath, content, numLines,
  startLine, totalLines}}`, so **the full file content is in the log**. Bash's is `{stdout, stderr, interrupted, isImage,
  noOutputExpected}`.

This was a non-interactive (`-p`) run. The interactive demo (with the trust dialog) is still to be run by the founder,
and its captures replace the docs fixtures.

## 5c. Denied calls and prompts (Task #2, 2026-10-31, Claude Code 2.1.316)

**Claim checked:** "the PreToolUse event is logged before the permission prompt, so denied attempts are still captured."
**Verdict: correct.**
- Docs (hooks reference, PermissionRequest section): *"PreToolUse hooks run before every tool call, whether or not it
  needs permission. PermissionRequest hooks run only when Claude Code is about to ask you for permission."* Also, a
  PreToolUse `"allow"` *skips* the prompt, which is only possible if PreToolUse runs before it. And *"Deny and ask
  rules are still evaluated regardless of what the hook returns."*
- What a denial leaves in the log: a `PreToolUse` line and **no** `PostToolUse`. The docs say `PostToolUseFailure`
  "doesn't fire for calls rejected before execution, such as ... permission denials". `PermissionDenied` fires
  **only in auto mode**: *"it doesn't run when you manually deny a permission dialog, when a PreToolUse hook blocks a
  call, or when a deny rule matches."*
- Empirical: `claude -p "Run exactly this shell command and nothing else: touch denied-proof.txt" --permission-mode default`
  in a scratch project. The log showed `pre Bash touch denied-proof.txt` with no post event, and the file was not
  created. (In `-p` nobody can answer the prompt, so Claude Code denies it. The interactive "No" click is covered by
  the docs quote above, and playbook scenario 1 re-checks it live.)
- **UNCLEAR:** the order of PreToolUse versus a matching settings `deny` rule. The docs say deny rules are evaluated
  "regardless" of the hook, but they don't say whether the hook still runs when a deny rule matches first.

**UserPromptSubmit** is now logged too, so labels can show which prompt caused a tool call. A real payload had
`session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt`. Its `prompt_id` matches the
`prompt_id` on the tool events of that turn. Veto prints nothing, so no context is added for Claude. Default timeout
for this event is 30 s; Veto sets 10 s.

## 6. Other UNCLEAR / open items

1. **UNCLEAR:** whether `tool_use_id` appears on `PostToolUseFailure` (it's not in that event's table).
2. **UNCLEAR:** the exact size of `tool_input`/`tool_response` for big reads and writes. Logging the full event can make
   `log.jsonl` large and can capture whole file contents (sensitive). No cap in Task #1; flagged for later.
3. **DECIDED (founder, 2026-10-31):** `veto init` writes `.claude/settings.local.json` by default; `veto init --shared`
   writes `.claude/settings.json`. `veto uninstall` removes Veto's entries from whichever of the two contain them.
4. On this machine the repo sits on an **exFAT** drive. exFAT ignores `chmod`, so the 0600 permissions **can't take
   effect here**. Tests that check permissions must run in an OS temp dir (`/tmp`, ext4), and the demo sandbox should
   live under `$HOME` (ext4), not `../veto-sandbox` on the exFAT drive.

## 7. Guard mode: deny and ask (Task #4, 2026-10-31)

Re-read from the official docs on 2026-10-31: hooks reference "PreToolUse decision control" and "PreToolUse `ask`
decisions in auto mode"; permissions "Extend permissions with hooks"; permission modes "auto", "dontAsk",
"bypassPermissions". Quotes are verbatim.

### Output shape (exit 0, one JSON object on stdout)
```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Veto: ..." } }
```
The same shape with `"ask"`. The top-level `decision`/`reason` fields are deprecated for PreToolUse.

### deny
- *"`"deny"` prevents the tool call."* *"For `"deny"`, [the reason is] shown to Claude."* Lifecycle: *"Claude Code reads
  the JSON decision, blocks the tool call, and shows Claude the reason."*
- *"A hook that blocks by exiting 2 routes the same way as `"deny"`"*. Veto uses JSON so the exit code stays 0, and
  a broken JSON write can't turn into a block (fail open).
- The docs list **no permission mode that ignores a hook deny**. The permissions page says *"The hook output can deny
  the tool call, force a prompt, or skip the prompt"*, and deny is first in precedence (*"`deny` > `defer` > `ask` >
  `allow`"* when hooks disagree). **UNCLEAR:** a mod can approve a call a PreToolUse hook blocked, in setups
  without managed settings or a Team/Enterprise login (*"the mod can approve a call that a deny rule refuses or a
  `PreToolUse` hook blocked"*). Veto can't prevent that. It only matters if the user installs such a mod.

### ask
- *"`"ask"` prompts the user to confirm."* *"For `"ask"`, [the reason is] shown to the user in the permission
  prompt."* The prompt is labelled `[settings]` for a settings-file hook. **Claude does not see an ask reason** in an
  interactive session, so Veto also sends the reason as `additionalContext` (*"String added to Claude's context
  alongside the tool result"*). Then Claude knows why it was asked, whatever the user picks.
- In `-p` runs: *"When Claude Code denies the call in a `-p` run where no one can answer that prompt, Claude reads the
  reason in the tool result instead."*
- Settings rules still apply: *"a matching deny rule blocks the call, and a matching ask rule still prompts even
  when the hook returned `"allow"` or `"ask"`."*

### Does "ask" force a human prompt in auto mode? **Yes (documented), with one carve-out.**
- *"In auto mode, a PreToolUse hook's `"ask"` normally sends the tool call to the permission prompt, and the classifier
  doesn't decide it."* Also, from permission modes: *"... prompts forced by one of your `ask` rules or by a hook ...
  auto mode still shows you those prompts"*.
- Carve-out: *"Calls that Claude Code's own checks flag too: these include writes to protected paths and commands that
  ask to run outside the sandbox. The classifier can deny one of these calls before any prompt appears. If it
  approves, the call normally still goes to the prompt."* So the worst case here is a denial, never a silent run.
- `SubagentHandback` never prompts; only `"deny"` stops it. (Veto has no rules for it.)
- To verify live: Task #4 manual plan, prompt 3, run with auto mode ON.

### bypassPermissions mode: **UNCLEAR**
- The mode *"disables permission prompts and safety checks so tool calls execute immediately"*. The section lists what
  still prompts (*"actions no mode auto-approves"*, *"Explicit ask rules and recognized `rm` and `rmdir` critical-path
  removals still prompt"*), and **a PreToolUse hook's `"ask"` is not in that list**.
- Indirect hint that it does prompt: in the troubleshooting list for removals that keep prompting in bypass mode,
  *"A `PreToolUse` hook answers `ask` for a removal: change what the hook returns"*.
- Deny in bypass mode: nothing in the docs says it's skipped (see "deny" above). Not yet verified live.
- Implication: if "ask" turns out to be skipped in bypass mode, a medium finding would run unprompted there. An
  option for later (not built): when `permission_mode` is `bypassPermissions`, escalate "ask" to "deny".

### dontAsk mode: ask becomes a denial (**inferred**)
- *"Claude Code auto-denies every tool call that would otherwise prompt you"* and *"denies calls matching your explicit
  `ask` rules rather than prompting."* The docs don't name hook asks explicitly, but a hook "ask" is a prompt, so it
  should be denied. **UNCLEAR** until checked live.

### Never "allow"
Unchanged and re-confirmed: *"`"allow"` skips the permission prompt"*. Guard mode outputs only "deny" or "ask".
Everything else (watch mode, no findings, only "log" findings, any error) is exit 0 with empty stdout.

## Sources
- Hooks reference: https://code.claude.com/docs/en/hooks (also served as markdown at https://code.claude.com/docs/en/hooks.md)
  - Sections used: Hook lifecycle, Configuration, Hook locations, Matcher patterns, Hook handler fields, Command hook fields,
    Exec form and shell form, Common input fields, Exit code output, Timeouts, Block the action when a hook fails,
    Hooks that start a background process, JSON output, PreToolUse, PostToolUse, PostToolUseFailure, Disable or remove
    hooks, Workspace trust, Debug hooks
- Settings files and precedence: https://code.claude.com/docs/en/settings
- Permissions / workspace trust (linked from the hooks page): https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
- Section 7 (guard mode): https://code.claude.com/docs/en/hooks.md (PreToolUse decision control; PreToolUse `ask`
  decisions in auto mode), https://code.claude.com/docs/en/permissions.md (Extend permissions with hooks; Precedence
  among rules, hooks, and mods), https://code.claude.com/docs/en/permission-modes.md (auto, dontAsk,
  bypassPermissions; Why the critical-path removal prompt stays on). Fetched 2026-10-31.
