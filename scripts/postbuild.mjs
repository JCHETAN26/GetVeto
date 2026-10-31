// Make the CLI entry executable (harmless no-op on filesystems without POSIX modes).
import { chmodSync } from "node:fs";
try { chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755); } catch {}
