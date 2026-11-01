import { describe, expect, it } from "vitest";
import { broad } from "../../src/rules/destructive/broad.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string, cwd?: string | null) => sev(runBash(broad, command, { cwd }));

describe("destructive/broad: find", () => {
  it("near-miss: find -delete inside the project (fine) vs in home (high)", () => {
    expect(s("find . -name '*.log' -delete")).toBeNull();
    expect(s("find dist -type f -delete")).toBeNull();
    expect(s("find ~ -name '*.log' -delete")).toBe("high");
  });

  it("-exec rm and sh -c 'rm' count; other -exec and plain find don't", () => {
    expect(s("find /var/log -name '*.gz' -exec rm {} \\;")).toBe("high");
    expect(s("find /tmp -name 'build-*' -exec rm -rf {} +")).toBe("medium");
    expect(s("find ~/Downloads -exec sh -c 'rm \"$1\"' _ {} \\;")).toBe("high");
    expect(s("find ~ -name '*.md' -exec grep -l TODO {} +")).toBeNull();
    expect(s("find / -name package.json")).toBeNull();
  });

  it("no start path means the cwd; an unknown cwd or variable start is medium", () => {
    expect(s("find -name '*.tmp' -delete")).toBeNull();
    expect(s("cd .. && find -name '*.tmp' -delete")).toBe("high");
    expect(s("find $DIR -delete")).toBe("medium");
    expect(s("find . -delete", null)).toBe("medium");
  });
});

describe("destructive/broad: chmod / chown -R", () => {
  it("near-miss: chmod -R inside the project (fine) vs on home (high)", () => {
    expect(s("chmod -R u+w dist")).toBeNull();
    expect(s("chmod -R 755 ~")).toBe("high");
  });

  it("system paths high; non-recursive and /tmp aren't flagged", () => {
    expect(s("sudo chown -R alice:alice /usr/local")).toBe("high");
    expect(s("chgrp -R staff ~/shared")).toBe("high");
    expect(s("chmod 600 ~/.netrc")).toBeNull();
    expect(s("chmod -R 777 /tmp/cache")).toBeNull();
    expect(s("chmod +x scripts/build.sh")).toBeNull();
  });

  it("--reference has no mode operand; globs and variables are flagged lower", () => {
    expect(s("chmod -R --reference=package.json ~/notes")).toBe("high");
    expect(s("chmod -R 700 ~/projects/*")).toBe("medium");
    expect(s("chown -R me $TARGET")).toBe("medium");
  });
});

describe("destructive/broad: dd and mkfs", () => {
  it("dd to a device is high; to a file is low or medium; mkfs is high", () => {
    expect(s("sudo dd if=ubuntu.iso of=/dev/sdb bs=4M")).toBe("high");
    expect(s("dd if=/dev/zero of=test.img bs=1M count=10")).toBe("low");
    expect(s("dd if=/dev/zero of=/dev/null count=1")).toBe("low");
    expect(s("dd if=/dev/zero of=~/big.img bs=1M count=10")).toBe("medium");
    expect(s("sudo mkfs.ext4 /dev/sdb1")).toBe("high");
    expect(s("mkfs -t ext4 /dev/sdb1")).toBe("high");
  });

  it("everyday commands are not flagged", () => {
    for (const c of ["ls -la", "npm test", "git status", "du -sh node_modules", "df -h", "find src -name '*.ts'"]) {
      expect(s(c), c).toBeNull();
    }
  });
});

describe("destructive/broad: reason wording", () => {
  it("outside-project targets read naturally", () => {
    expect(runBash(broad, "find /tmp/cache -delete")[0]!.reason).toBe("find -delete in a path outside the project (/tmp/cache).");
  });
});
