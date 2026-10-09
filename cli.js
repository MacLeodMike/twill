#!/usr/bin/env node
// The `twill` CLI bin. The CLI is TypeScript source (no build step in this
// package); this shim runs it through tsx (a runtime dependency, so it's
// present in the package's own node_modules after install).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "src", "cli", "twill.ts");
// Resolve the package's own tsx binary.
const tsxCli = join(here, "node_modules", "tsx", "dist", "cli.mjs");

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
