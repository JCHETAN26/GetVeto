# Docs-sourced fixtures (NOT real captures)

These payloads are copied **verbatim** from the official Claude Code hooks reference:
https://code.claude.com/docs/en/hooks (sections "Common input fields" and "PostToolUse input"), fetched 2026-10-31.

They exist only so integration tests can run before real payloads are captured. Per CLAUDE.md rule 1, as soon as
`test/fixtures/real/` contains captured payloads, the integration tests use those **instead of** these.
