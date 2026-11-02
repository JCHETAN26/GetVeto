import { describe, expect, it } from "vitest";
import { shellRead } from "../../src/rules/secret-access/shell-read.js";
import { HOME, ROOT, runBash, sev } from "../rule-helpers.js";

const s = (command: string, cwd?: string) => sev(runBash(shellRead, command, cwd ? { cwd } : {}));

describe("secret-access/shell-read", () => {
  it("everyday reads: .env and secrets flag, templates and ordinary files don't", () => {
    expect(runBash(shellRead, "cat .env")).toEqual([
      {
        ruleId: "secret-access/shell-read",
        category: "secret-access",
        severity: "medium",
        reason: "cat reads an .env file, which may hold secrets: .env.",
        suggestion: "Read .env.example instead, or ask the user for the specific value you need.",
      },
    ]);
    expect(s("grep PORT .env")).toBe("medium");
    expect(s("cat ~/.aws/credentials")).toBe("medium");
    expect(runBash(shellRead, "cat ~/.aws/credentials")[0]!.suggestion).toBe("Ask the user for the specific value you need instead of reading the file.");
    for (const c of ["cat .env.example", "cat README.md", "grep -rn TODO src", "head -n 20 package.json", "cp .env.example .env"]) expect(s(c), c).toBeNull();
  });

  it("the pattern of grep/sed is not a file; option values are not files", () => {
    for (const c of ["grep .env .gitignore", "grep -e .env .gitignore", "rsync -a --exclude .env src/ dist/", "scp -i ~/.ssh/id_ed25519 build.tar host:/srv"]) expect(s(c), c).toBeNull();
    expect(s("sed -n 1,5p .env.local")).toBe("medium");
  });

  it("input redirection and copies", () => {
    expect(runBash(shellRead, "wc -l < .env")[0]!.reason).toBe("Input redirection (<) reads an .env file, which may hold secrets: .env.");
    expect(runBash(shellRead, "cp .env .env.bak")[0]!.reason).toBe("cp copies an .env file, which may hold secrets: .env.");
  });

  it("git history: content flags, names and stats don't", () => {
    expect(s("git show HEAD:.env")).toBe("medium");
    expect(s("git log -p -- .env")).toBe("medium");
    for (const c of ["git show HEAD --stat", "git log -- .env", "git diff --name-only -- .env", "git diff -- src/app.ts"]) expect(s(c), c).toBeNull();
  });

  it("paths are cwd-aware; unresolved words never trigger", () => {
    expect(s("cat config", `${HOME}/.ssh`)).toBe("medium");
    expect(s("cat config", ROOT)).toBeNull();
    for (const c of ["cat $FILE", "cat *.pem", "cat $(ls .env*)"]) expect(s(c), c).toBeNull();
  });
});
