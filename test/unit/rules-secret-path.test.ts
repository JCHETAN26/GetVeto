import { describe, expect, it } from "vitest";
import { secretPath } from "../../src/rules/file-tools/secret-path.js";
import { ROOT, sev, toolCtx } from "../rule-helpers.js";

const s = (tool: string, file_path: string) => sev(secretPath.check(toolCtx(tool, { file_path })));

describe("file-tools/secret-path", () => {
  it("near-miss: .env.example (fine) vs .env (medium)", () => {
    expect(s("Read", `${ROOT}/.env.example`)).toBeNull();
    expect(s("Read", `${ROOT}/.env`)).toBe("medium");
  });

  it(".env variants; templates and look-alikes are fine", () => {
    for (const p of [".env.local", ".env.production", "config/.env"]) expect(s("Read", `${ROOT}/${p}`), p).toBe("medium");
    for (const p of [".env.sample", ".env.template", ".envrc", "env.ts", "src/dotenv.js"]) expect(s("Read", `${ROOT}/${p}`), p).toBeNull();
  });

  it("keys, certificates and ~/.ssh", () => {
    expect(s("Read", `${ROOT}/certs/server.pem`)).toBe("medium");
    expect(s("Read", `${ROOT}/certs/server.key`)).toBe("medium");
    expect(s("Read", "/home/alice/.ssh/config")).toBe("medium");
    expect(s("Read", "/home/alice/keys/id_ed25519")).toBe("medium");
    expect(s("Read", "/home/alice/backup/id_rsa.old")).toBe("medium");
    expect(s("Read", `${ROOT}/src/keyboard.ts`)).toBeNull();
    expect(s("Read", `${ROOT}/docs/monkey.md`)).toBeNull();
  });

  it("applies to Read, Write and Edit; not to other tools", () => {
    expect(s("Write", `${ROOT}/.env`)).toBe("medium");
    expect(s("Edit", `${ROOT}/.env`)).toBe("medium");
    expect(s("Glob", `${ROOT}/.env`)).toBeNull();
  });

  it("reason names the file but not its folder", () => {
    const f = secretPath.check(toolCtx("Read", { file_path: `${ROOT}/.env.local` }));
    expect(f[0]!.reason).toBe("Read on an .env file, which may hold secrets: .env.local.");
  });
});
