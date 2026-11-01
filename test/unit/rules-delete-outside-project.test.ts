import { describe, expect, it } from "vitest";
import { deleteOutsideProject } from "../../src/rules/destructive/delete-outside-project.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string, cwd?: string | null) => sev(runBash(deleteOutsideProject, command, { cwd }));

describe("destructive/delete-outside-project: deletes", () => {
  it("near-miss: rm of a project file (fine) vs a file in home (medium) vs a system file (high)", () => {
    expect(s("rm notes.txt")).toBeNull();
    expect(s("rm ~/notes.txt")).toBe("medium");
    expect(s("sudo rm /etc/hosts.bak")).toBe("high");
  });

  it("the shape of the real 19:53:36 command: rm -- two files in ~/veto-test-junk", () => {
    const f = runBash(deleteOutsideProject, "rm -- ~/veto-test-junk/fake1.txt ~/veto-test-junk/fake2.txt && ls -la ~/veto-test-junk");
    expect(f.map((x) => [x.severity, x.reason])).toEqual([
      ["medium", "rm deletes a file in your home directory (~/veto-test-junk/fake1.txt)."],
      ["medium", "rm deletes a file in your home directory (~/veto-test-junk/fake2.txt)."],
    ]);
  });

  it("project files are normal dev work: never flagged", () => {
    for (const c of ["rm -f package-lock.json", "rm src/old.js test/old.test.js", "rm ./*.log", "unlink build.lock", "shred -u tmp/key.txt", "truncate -s 0 app.log", "rm ../app/README.md"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("outside the project (scratch dirs, other mounts) is medium", () => {
    expect(s("rm /tmp/build.log")).toBe("medium");
    expect(s("rm -f /mnt/data/old.csv")).toBe("medium");
    expect(s("cd .. && rm other.txt")).toBe("medium"); // /home/alice/code/other.txt
  });

  it("unlink, shred and truncate -s 0 (all spellings); other truncate sizes aren't deletes", () => {
    expect(s("unlink ~/.bash_history")).toBe("medium");
    expect(s("shred -n 3 -u ~/old.txt")).toBe("medium");
    expect(s("truncate -s 0 ~/.zsh_history")).toBe("medium");
    expect(s("truncate -s0 /var/log/syslog")).toBe("high");
    expect(s("truncate --size=0 ~/a.log")).toBe("medium");
    expect(s("truncate --size 0 ~/a.log")).toBe("medium");
    expect(s("truncate -s 10M ~/disk.img")).toBeNull();
  });

  it("unknown or unresolved targets are low and say they couldn't be resolved", () => {
    const f = runBash(deleteOutsideProject, "rm $OLD_FILE");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "low" });
    expect(f[0]!.reason).toMatch(/couldn't be resolved/);
    expect(s("rm ~/Downloads/*.zip")).toBe("low");
    expect(s("rm notes.txt", null)).toBe("low");
    expect(s("find ~ -name '*.bak' | xargs rm")).toBe("low");
  });

  it("recursive rm is left to recursive-rm (no double finding)", () => {
    expect(s("rm -rf ~/Downloads")).toBeNull();
    expect(s("rm -r ~/x")).toBeNull();
  });

  it("looks inside bash -c", () => {
    expect(s("bash -c 'rm ~/notes.txt'")).toBe("medium");
  });
});

describe("destructive/delete-outside-project: mv out of the user's space", () => {
  it("near-miss: mv inside the project (fine) vs from home into the project (medium)", () => {
    expect(s("mv src/a.js src/b.js")).toBeNull();
    expect(s("mv ~/Documents/report.pdf ./docs/")).toBe("medium");
  });

  it("into /dev/null, with -t, and several sources", () => {
    expect(s("mv ~/.bashrc /dev/null")).toBe("medium");
    expect(s("mv -t vendor/ ~/lib/a.js /opt/lib/b.js")).toBe("medium");
    expect(runBash(deleteOutsideProject, "mv ~/a.txt ~/b.txt src/")).toHaveLength(2);
    expect(s("mv --target-directory=vendor ~/lib/a.js")).toBe("medium");
  });

  it("not flagged: project to elsewhere, home to home", () => {
    expect(s("mv dist ~/backup/dist-old")).toBeNull();
    expect(s("mv ~/a.txt ~/b.txt")).toBeNull();
    expect(s("mv /tmp/x /tmp/y")).toBeNull();
  });

  it("unresolved source or destination is low", () => {
    expect(s("mv $SRC ./vendor/")).toBe("low");
    expect(s("mv ~/a.txt $DEST")).toBe("low");
  });
});


describe("reason wording (found in a real claude -p probe: 'a file in outside the project')", () => {
  it("reads naturally for each place", () => {
    const r = (c: string) => runBash(deleteOutsideProject, c)[0]!.reason;
    expect(r("rm /tmp/x.txt")).toBe("rm deletes a file outside the project (/tmp/x.txt).");
    expect(r("rm ~/x.txt")).toBe("rm deletes a file in your home directory (~/x.txt).");
    expect(r("rm /etc/x.conf")).toBe("rm deletes a file in a system location (/etc/x.conf).");
    expect(r("mv /tmp/x.txt src/")).toBe("mv moves a file out of a folder outside the project (/tmp/x.txt) into the project.");
  });
});
