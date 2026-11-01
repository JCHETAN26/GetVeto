// Builds what ships in dist/ (see docs/decisions.md D3):
//   dist/package.json  {"type":"commonjs"}: dist/*.js load as CommonJS (faster to start than ESM)
//   dist/cli.js        tiny entry, the path `veto init` writes into the hook command (unchanged
//                      since Task #1, so existing installs keep working)
//   dist/veto.js       the whole CLI and its dependencies (unbash) in one CommonJS file
//   dist/THIRD_PARTY_LICENSES.txt  licenses of bundled dependencies
// The tsc output in build/ is for tooling only (eval, bench-parse, capture-fixtures).
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
  entryPoints: [join(repo, "src", "cli.ts")],
  outfile: join(dist, "veto.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  // The sources are ESM and use import.meta.url to find files next to themselves; in the bundle
  // that is dist/veto.js, which sits where the tsc-built modules used to (dist/), so relative
  // URLs (./cli.js, ../package.json) keep resolving to the same files.
  define: { "import.meta.url": "__veto_import_meta_url" },
  banner: { js: 'var __veto_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
});

writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
writeFileSync(
  join(dist, "cli.js"),
  `#!/usr/bin/env node
// Veto CLI entry. The code is in ./veto.js (one bundled file, see docs/decisions.md D3).
"use strict";
require("./veto.js");
`,
);
chmodSync(join(dist, "cli.js"), 0o755);

const unbash = join(repo, "node_modules", "unbash");
const { version } = JSON.parse(readFileSync(join(unbash, "package.json"), "utf8"));
writeFileSync(
  join(dist, "THIRD_PARTY_LICENSES.txt"),
  `dist/veto.js bundles the following package:\n\nunbash ${version}\n\n${readFileSync(join(unbash, "LICENSE"), "utf8")}`,
);
