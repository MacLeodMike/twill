// CLI tests (Task 7) — the `twill` CLI is the registry HTTP surface's
// first consumer, exercised exactly as any consumer would be: over HTTP,
// never by importing registry internals into the CLI process.
//
// A fixture-backed server boots once on an ephemeral port (beforeAll) and
// the CLI is spawned per test via `node_modules/.bin/tsx src/cli/twill.ts`
// with TWILL_REGISTRY pointed at the server. The fixture pair aliases its
// storage fingerprints, so the boot applies the same one-line mutation as
// the Task 5/6 harnesses before start(). tsx cold-start is slow; every
// test gets a generous timeout.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { start, type RegistryStore } from "../registry/store.js";
import { createServer } from "../registry/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const fixtures = resolve(repoRoot, "fixtures/documents");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const cliEntry = resolve(here, "twill.ts");

const SPAWN_TIMEOUT_MS = 30_000;

let server: Server;
let store: RegistryStore;
let dir: string;
let registry: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "twill-cli-"));
  cpSync(fixtures, dir, { recursive: true });
  // Good baseline: break the fixture pair's fingerprint aliasing.
  const p = join(dir, "Workspace", "payments-repo.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("vol-2c4f1a", "vol-payments-01"));

  store = start(dir);
  server = createServer(store);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  registry = `http://127.0.0.1:${port}/twill/v1alpha1`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

type CliResult = { code: number; stdout: string; stderr: string };

/** Spawn the CLI; resolve on any exit (a nonzero exit is a result, not a rejection). */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      tsxBin,
      [cliEntry, ...args],
      { env: { ...process.env, TWILL_REGISTRY: registry } },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error); // spawn itself failed (ENOENT etc.) — not a CLI exit
          return;
        }
        const code = error === null ? 0 : (error.code as number);
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

describe("twill CLI", () => {
  it(
    "resolve prints the attached descriptor and exits 0",
    async () => {
      const r = await runCli(["resolve", "Workspace", "workstation-repos", "--principal", "user:test"]);
      expect(r.code).toBe(0);
      const descriptor = JSON.parse(r.stdout) as { route?: { type?: string } };
      expect(descriptor.route?.type).toBe("local");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list shows both fixture workspaces",
    async () => {
      const r = await runCli(["list"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("workstation-repos");
      expect(r.stdout).toContain("payments-repo");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "resolve of an unknown name prints NoMatch and exits 2",
    async () => {
      const r = await runCli(["resolve", "Workspace", "no-such-workspace", "--principal", "user:test"]);
      expect(r.code).toBe(2);
      expect(r.stdout.trim()).toBe("NoMatch");
    },
    SPAWN_TIMEOUT_MS,
  );
});
