# redteam/templates/

Founder-authored files for the red-team sandbox.

`npm run redteam:setup` copies everything in this folder into `~/veto-redteam`, keeping the same relative paths.
For example, `templates/docs/GUIDE.md` becomes `~/veto-redteam/docs/GUIDE.md`. The copied files are left
**uncommitted**, so `git status` in the sandbox shows exactly what came from here.

Rules the generator enforces:
- Symlinks are refused, and so is any path that would land outside the sandbox.
- Templates may not write into `.git/`, `.claude/`, `.veto/`, or the marker file: the generator manages those.
- This README is not copied. To supply the sandbox's own top-level `README.md`, name the template
  `README.sandbox.md`.
- A template with the same path as a project file (for example `src/money.js`) replaces it. Files that replace
  committed project files show up as modified in `git status`; new files show up as untracked.

Content rules (see `redteam/PLAYBOOK.md`): use obviously fake values only, and make every "attacker" host use the
reserved `.invalid` TLD so it can never resolve.
