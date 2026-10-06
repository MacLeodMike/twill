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
//
// The claims block (T2a Task 6) runs serially in a fixed order (a)–(d):
// one claim is created, listed, released, and verified absent — the claim
// name is threaded through the block's outer scope because each step's
// assertions depend on the previous step's server-side state.

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
  // Good baseline: drop the lineage-linked worktree child and break the
  // fixture pair's fingerprint aliasing.
  rmSync(join(dir, "Workspace", "payments-repo-feat-x.yaml"), { force: true });
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

describe("twill CLI — claims (T2a Task 6)", () => {
  // Serial block: (a) create → (b) list → (c) release → (d) absent.
  let claimName = "";

  it(
    "(a) claim create exits 0 and prints the created claim as JSON",
    async () => {
      const r = await runCli([
        "claim",
        "create",
        "Workspace",
        "payments-repo",
        "--principal",
        "user:cli-test",
        "--route",
        JSON.stringify({ type: "local", path: "~/repos/payments-repo" }),
        "--param",
        "branch=feat-cli",
      ]);
      expect(r.code).toBe(0);
      const created = JSON.parse(r.stdout) as {
        kind?: string;
        metadata?: { name?: string };
        spec?: {
          owner?: string;
          parent?: { kind?: string; name?: string };
          claim?: {
            id?: string;
            principal?: string;
            released?: boolean;
            parameters?: Record<string, string>;
            claimedOn?: { durable_id?: string; fingerprint?: string };
          };
        };
      };
      expect(created.kind).toBe("Claim");
      claimName = created.metadata?.name ?? "";
      expect(claimName).toMatch(/^claim-payments-repo-user-cli-test-\d+$/);
      expect(created.spec?.owner).toBe("user:cli-test");
      expect(created.spec?.parent).toEqual({ kind: "Workspace", name: "payments-repo" });
      // The CLI computed claimedOn from the parent document (the harness
      // re-fingerprints payments-repo to vol-payments-01 at boot).
      expect(created.spec?.claim?.claimedOn).toEqual({
        durable_id: "ws_01J8Z4-payments-repo",
        fingerprint: "vol-payments-01",
      });
      expect(created.spec?.claim?.released).toBe(false);
      expect(created.spec?.claim?.parameters).toEqual({ branch: "feat-cli" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "(b) claims Workspace payments-repo lists the created claim",
    async () => {
      expect(claimName).not.toBe("");
      const r = await runCli(["claims", "Workspace", "payments-repo"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(claimName);
      expect(r.stdout).toContain("user:cli-test");
      expect(r.stdout).toContain("ws_01J8Z4-payments-repo");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "(c) claim release exits 0 and prints the released claim",
    async () => {
      expect(claimName).not.toBe("");
      const r = await runCli(["claim", "release", "Workspace", "payments-repo", claimName]);
      expect(r.code).toBe(0);
      const released = JSON.parse(r.stdout) as {
        metadata?: { name?: string };
        spec?: { claim?: { released?: boolean } };
      };
      expect(released.metadata?.name).toBe(claimName);
      expect(released.spec?.claim?.released).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "(d) the released claim is absent from the default claims listing",
    async () => {
      expect(claimName).not.toBe("");
      const r = await runCli(["claims", "Workspace", "payments-repo"]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain(claimName);
    },
    SPAWN_TIMEOUT_MS,
  );
});
