#!/usr/bin/env node
// Veto CLI entry, copied to dist/cli.js by scripts/bundle.mjs. The code is in ./veto.js, one
// bundled CommonJS file (see docs/decisions.md D3).
//
// Node's compile cache (Node >= 22.1; skipped on Node 20): V8 keeps the compiled code of
// dist/veto.js in <cache>/getveto, where <cache> is $XDG_CACHE_HOME or ~/.cache. That is the only
// place Veto writes outside a project's .veto/. Node checks each entry against the source and
// recompiles on any mismatch, so a stale or damaged cache only costs time. VETO_NO_COMPILE_CACHE=1
// turns it off. Any error here is ignored: the CLI just runs without the cache.
"use strict";
try {
  const { enableCompileCache } = require("node:module");
  if (typeof enableCompileCache === "function" && !process.env.VETO_NO_COMPILE_CACHE) {
    const { isAbsolute, join } = require("node:path");
    const xdg = process.env.XDG_CACHE_HOME;
    const home = require("node:os").homedir();
    const base = xdg && isAbsolute(xdg) ? xdg : home && isAbsolute(home) ? join(home, ".cache") : null;
    if (base) enableCompileCache(join(base, "getveto"));
  }
} catch {
  // no cache
}
require("./veto.js");
