import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    // Every CLI the tests spawn inherits this: Node's compile cache (src/entry.cjs) goes to a temp
    // dir, never the real ~/.cache.
    env: { XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "veto-test-cache-")) },
  },
});
