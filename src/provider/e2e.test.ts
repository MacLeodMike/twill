// End-to-end provider test (T2.5 Task 5, Review Focus #6) — the full loop
// closed through the CLI as a real process boundary:
//
//   fixture registry (store + createServer, in-process)
//   + a cold local parent workspace (route carries a gitClone precondition)
//   + `twill provider --config <file>` spawned as a REAL child process
//     (the standalone shape from provider spec §2 — the thin wrapper over
//     the same startProvider twill-pi embeds)
//   + consumer `twill claim create` over HTTP (the CLI's own claim command)
//   → provider fulfills (clone materializes on disk)
//   → the child appears in GET /Workspace/<child>
//   → the child's ready:true lands on the status read surface
//   → the consumer's `twill resolve(Workspace, <child>)` returns the route
//     with the child path
//
// Note on "GET /Workspace/<child> returns it with ready:true": GET serves
// the document envelope verbatim (doc.raw — the registry's Pin 5); provider
// statusReports live in the status cache whose only read surface is
// resolve (the descriptor's status). So the assertions split: GET proves
// the child EXISTS in the overlay; the resolve descriptor proves its
// ready:true.
//
// The harness reuses the loop.test.ts fixture shape: fixture documents
// copied per run with the same one-line fingerprint mutation, tmp git
// origin + seed (commit signing disabled locally — the user's global git
// config enforces it), short poll intervals (50 ms), generous timeouts
// (tsx cold-start + git are slow). The provider child process is always
// SIGKILLed in cleanup if a test fails before the SIGINT assertion.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { start, type RegistryStore } from "../registry/store.js";
import { createServer } from "../registry/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const fixtures = resolve(repoRoot, "fixtures/documents");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const cliEntry = resolve(repoRoot, "src/cli/twill.ts");

let server: Server;
let store: RegistryStore;
let dir: string;
let registry: string;

const openDirs: string[] = [];
const openChildren: ChildProcess[] = [];

/** Run git; reject (with stderr) on nonzero exit. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || error.message}`));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

/** A git fixture: bare origin + seed clone with one commit on main. */
async function gitFixture(): Promise<{ origin: string; seed: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "twill-e2e-git-"));
  openDirs.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", "-q", origin, seed]);
  await git(seed, ["config", "user.email", "fixture@twill"]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(seed, "f.txt"), "v1\n");
  await git(seed, ["add", "."]);
  const when = new Date(1_700_000_000_000).toISOString();
  await git(seed, ["-c", `user.date=${when}`, "commit", "-qm", "c1"], { GIT_COMMITTER_DATE: when });
  await git(seed, ["push", "-q", "origin", "HEAD:main"]);
  return { origin, seed, root };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "twill-e2e-"));
  cpSync(fixtures, dir, { recursive: true });
  // Good baseline (the loop.test.ts mutation): drop the lineaged worktree
  // child and give workstation-repos its own fingerprint, so the e2e parent
  // is the only lineaged pair it creates.
  rmSync(join(dir, "Workspace", "payments-repo-feat-x.yaml"), { force: true });
  const wsr = join(dir, "Workspace", "workstation-repos.yaml");
  writeFileSync(wsr, readFileSync(wsr, "utf8").replace("vol-2c4f1a", "vol-wsr-01"));

  store = start(dir);
  server = createServer(store);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  registry = `http://127.0.0.1:${port}/twill/v1alpha1`;
});

afterAll(async () => {
  for (const child of openChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
  for (const d of openDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type CliResult = { code: number; stdout: string; stderr: string };

/** Spawn a one-shot CLI command (the consumer side); resolve on any exit. */
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
        resolvePromise({ code, stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

type SpawnedProvider = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/**
 * Spawn the long-running `twill provider` process. The config carries the
 * registry URL, so TWILL_REGISTRY is deliberately REMOVED from the child's
 * environment (the provider must be config-driven, not env-driven).
 */
function spawnProvider(configPath: string): SpawnedProvider {
  const env = { ...process.env };
  delete env["TWILL_REGISTRY"];
  const child = spawn(tsxBin, [cliEntry, "provider", "--config", configPath], { env });
  openChildren.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/** Poll `cond` until it holds or the deadline passes; true when it held. */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(intervalMs);
  }
  return false;
}

/** The child status surface via resolve (the only status read surface). */
async function resolveDescriptor(
  name: string,
): Promise<{ attached: boolean; status?: { ready?: boolean; progress?: string }; routePath?: string }> {
  const res = await fetch(`${registry}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "Workspace",
      name,
      consumer: { agentLocation: "workstation", agentKind: "", principal: "user:e2e" },
    }),
  });
  if (!res.ok) return { attached: false };
  const body = (await res.json()) as {
    result?: string;
    descriptor?: {
      status?: { ready?: unknown; progress?: unknown };
      route?: { path?: unknown };
    };
  };
  if (body.result !== "Attached") return { attached: false };
  const descriptor = body.descriptor ?? {};
  const status = typeof descriptor.status === "object" && descriptor.status !== null ? descriptor.status : {};
  return {
    attached: true,
    status: {
      ready: status.ready === true,
      progress: typeof status.progress === "string" ? status.progress : undefined,
    },
    routePath: typeof descriptor.route?.path === "string" ? descriptor.route.path : undefined,
  };
}

describe("twill provider — end-to-end claim fulfillment (Review Focus #6)", () => {
  it(
    "cold local workspace: claim via CLI → provider fulfills → child in overlay ready → consumer resolve returns the child path",
    async () => {
      const parent = "e2e-parent";
      const worktreeName = "wt-e2e";
      const childName = `${parent}-${worktreeName}`;
      const { origin } = await gitFixture();
      const rootPath = join(dir, "e2e-root");
      const childPath = join(rootPath, ".twill", parent, worktreeName);

      // The verbatim route the provider owns AND the consumer claims — a
      // cold local workspace route with a gitClone precondition (workspace
      // §6.2: the claim carries the resolved route verbatim).
      const route = {
        match: { agentLocation: "workstation" },
        type: "local",
        path: rootPath,
        precondition: { steps: [{ type: "gitClone", url: origin, ref: "main" }] },
      };

      // The parent fixture: a cold local workspace (nothing materialized yet).
      writeFileSync(
        join(dir, "Workspace", `${parent}.yaml`),
        `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: ${parent}, labels: { twill/workspace-class: git } }
spec:
  owner: user:e2e
  routes:
    - match: { agentLocation: workstation }
      type: local
      path: ${rootPath}
      precondition:
        steps:
          - { type: gitClone, url: ${origin}, ref: main }
  workspace:
    storageBacked: true
    accessMode: RWO
    storage:
      id: ws_e2e-01
      fingerprint: vol-e2e-01
    hostname: workstation
status: {}
`,
      );
      store.reload();

      // The provider config file (YAML; the registry URL deliberately lacks
      // the /twill/v1alpha1 prefix — the loop normalizes it).
      const configPath = join(dir, "provider-config.yaml");
      writeFileSync(
        configPath,
        `registry: http://127.0.0.1:${new URL(registry).port}
pollIntervalMs: 50
parents: [${parent}]
routes:
  - match: { agentLocation: workstation }
    type: local
    path: ${rootPath}
    precondition:
      steps:
        - { type: gitClone, url: ${origin}, ref: main }
`,
      );

      const provider = spawnProvider(configPath);
      try {
        // The provider boots and announces what it serves.
        expect(await waitFor(() => provider.stdout().includes("provider serving 1 parent(s), 1 route(s)"), 20_000)).toBe(
          true,
        );

        // The consumer claims, via the CLI's own claim command over HTTP.
        const claimed = await runCli([
          "claim",
          "create",
          "Workspace",
          parent,
          "--principal",
          "user:e2e",
          "--route",
          JSON.stringify(route),
          "--param",
          `worktreeName=${worktreeName}`,
          "--name",
          "claim-e2e",
        ]);
        expect(claimed.code).toBe(0);
        const claimDoc = JSON.parse(claimed.stdout) as { metadata?: { name?: string } };
        expect(claimDoc.metadata?.name).toBe("claim-e2e");

        // The provider fulfills: the child appears in the overlay. (GET
        // serves the document; readiness rides the status cache — below.)
        expect(
          await waitFor(async () => {
            const res = await fetch(`${registry}/Workspace/${childName}`);
            return res.status === 200;
          }, 30_000),
        ).toBe(true);

        // GET /Workspace/<child> returns the child document, via the CLI's
        // own get command.
        const got = await runCli(["get", "Workspace", childName]);
        expect(got.code).toBe(0);
        const childDoc = JSON.parse(got.stdout) as {
          metadata?: { name?: string };
          spec?: {
            parent?: { kind?: string; name?: string };
            routes?: Array<Record<string, unknown>>;
            workspace?: { storage?: { id?: string; fingerprint?: string } };
          };
        };
        expect(childDoc.metadata?.name).toBe(childName);
        expect(childDoc.spec?.parent).toEqual({ kind: "Workspace", name: parent });
        expect(childDoc.spec?.workspace?.storage?.id).toBe(`ws_e2e-01-${worktreeName}`);
        expect(childDoc.spec?.workspace?.storage?.fingerprint).toBe("vol-e2e-01");
        const childRoute = childDoc.spec?.routes?.[0];
        expect(childRoute?.["type"]).toBe("local");
        expect(childRoute?.["match"]).toEqual({ agentLocation: "workstation" });
        expect(childRoute?.["path"]).toBe(childPath);
        expect(childRoute?.["precondition"]).toBeUndefined();

        // The materialized clone is real: the seeded file is on disk.
        expect(readFileSync(join(childPath, "f.txt"), "utf8")).toBe("v1\n");

        // The child's ready:true lands on the status read surface.
        expect(
          await waitFor(async () => {
            const d = await resolveDescriptor(childName);
            return d.attached && d.status?.ready === true;
          }, 30_000),
        ).toBe(true);

        // The full loop closes: the consumer's resolve (the CLI, as a
        // consumer would run it) returns the route with the child path.
        const resolved = await runCli(["resolve", "Workspace", childName, "--principal", "user:e2e"]);
        expect(resolved.code).toBe(0);
        const descriptor = JSON.parse(resolved.stdout) as {
          route?: { path?: string; type?: string; precondition?: unknown };
          status?: { ready?: boolean };
        };
        expect(descriptor.route?.type).toBe("local");
        expect(descriptor.route?.path).toBe(childPath);
        expect(descriptor.route?.precondition).toBeUndefined();
        expect(descriptor.status?.ready).toBe(true);

        // The provider logged the fulfillment line to stdout.
        expect(
          await waitFor(
            () => provider.stdout().includes(`claim claim-e2e fulfilled: child ${childName} ready at ${childPath}`),
            10_000,
          ),
        ).toBe(true);
      } finally {
        // Graceful stop: SIGINT, the provider stops polling and exits 0.
        // (A failed test still gets here; SIGINT is the clean shutdown.)
        provider.child.kill("SIGINT");
      }
      const exit = await provider.exited;
      expect(exit.code).toBe(0);
      expect(provider.stderr()).toContain("SIGINT");
    },
    90_000,
  );

  it(
    "a malformed provider config exits 1 with the problem named on stderr",
    async () => {
      const configPath = join(dir, "provider-config-bad.yaml");
      // Missing `parents` (and a route without a type).
      writeFileSync(configPath, `registry: http://127.0.0.1:1\nroutes: [{}]\n`);
      const provider = spawnProvider(configPath);
      const exit = await provider.exited;
      expect(exit.code).toBe(1);
      expect(provider.stderr()).toContain("routes");
    },
    30_000,
  );

  it(
    "a JSON config file is accepted (JSON is YAML's strict subset)",
    async () => {
      const configPath = join(dir, "provider-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          registry,
          pollIntervalMs: 50,
          parents: ["e2e-json-parent"], // never registered — the poll just serves []
          routes: [{ type: "local", path: join(dir, "e2e-json-root") }],
        }),
      );
      const provider = spawnProvider(configPath);
      try {
        expect(await waitFor(() => provider.stdout().includes("provider serving 1 parent(s), 1 route(s)"), 20_000)).toBe(
          true,
        );
      } finally {
        provider.child.kill("SIGINT");
      }
      const exit = await provider.exited;
      expect(exit.code).toBe(0);
    },
    30_000,
  );
});
