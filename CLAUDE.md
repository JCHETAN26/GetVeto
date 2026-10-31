# Veto — instructions for every Claude Code session in this repo

Veto is a local safety layer for AI coding agents (starting with Claude Code). npm package `getveto`, CLI `veto`.
"Your agent proposes. You veto."

## Non-negotiable rules
1. NO MOCKS of the system we are integrating with. Never invent Claude Code hook payload shapes. The only acceptable
   fixtures are payloads captured from real Claude Code sessions (`test/fixtures/real/`). Until captured ones exist,
   integration tests may only use payload shapes copied verbatim from the official docs, clearly labeled as such.
2. Tests must exercise the real built CLI as a subprocess, not just internal functions.
3. Fail open: Veto must never break or hang the user's agent. Any internal error → allow the action and log the error.
4. Every task ends with a manual demo that the founder runs on their machine with real Claude Code.
5. Small, logical git commits with clear messages.

## Project facts worth knowing
- Hook API research lives in `docs/hooks-research.md`. Read it before touching hook I/O.
- "Allow" in observe-only mode means **exit 0 with empty stdout** (no decision; the normal permission flow applies).
  Never emit `permissionDecision: "allow"`, because that auto-approves the call and skips the user's prompt.
- Git commits must be authored as JCHETAN26 (repo-local git config). Never push without asking the founder.
