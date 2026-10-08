// Provider loop tests (T2.5 Task 3) — the poll loop, claim matching, and
// fulfillment against a REAL in-process registry (store + createServer,
// the CLI test harness pattern) and tmp git fixtures (the
// preconditions.test.ts fixture pattern: bare origin + seed clone, commits
// pushed from the seed). The provider is exercised exactly as a third
// party would run it: over HTTP, with fetch; it never touches the store.
//
// The registry boots on an ephemeral port over a tmpdir documents dir. The
// parent Workspace fixture is written per test with its local route's
// `path` pointed at the test's materialization root, and its `storage.id`
// / `fingerprint` unique per test (the §8.3 fingerprint-collision rule
// would otherwise reject a second child sharing the parent's fingerprint
// when the fixture registry is shared).
//
// Git fixtures: the user's global config enforces ssh commit signing, so
// the seed/working repos set commit.gpgsign=false locally — the fixtures
// must commit without the user's keys.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { start, type RegistryStore } from "../registry/store.js";
import { createServer } from "../registry/server.js";
import { startProvider } from "./loop.js";
import type { Route } from "../registry/document.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

let server: Server;
let store: RegistryStore;
let dir: string;
let registry: string;

const openDirs: string[] = [];

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

let commitCounter = 0;

async function seedCommit(seed: string, file: string, contents: string, message: string): Promise<void> {
  writeFileSync(join(seed, file), contents);
  await git(seed, ["add", "."]);
  const when = new Date(1_700_000_000_000 + commitCounter++ * 60_000).toISOString();
  await git(seed, ["-c", `user.date=${when}`, "commit", "-qm", message], { GIT_COMMITTER_DATE: when });
}

/**
 * A git fixture: bare origin + seed clone with one commit on main. Returns
 * {origin, seed, root}; root is tracked for cleanup.
 */
async function gitFixture(): Promise<{ origin: string; seed: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "twill-loop-git-"));
  openDirs.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", "-q", origin, seed]);
  await git(seed, ["config", "user.email", "fixture@twill"]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "commit.gpgsign", "false"]);
  await seedCommit(seed, "f.txt", "v1\n", "c1");
  await git(seed, ["push", "-q", "origin", "HEAD:main"]);
  return { origin, seed, root };
}

/**
 * Write a parent Workspace fixture whose local route's path is `rootPath`
 * (the materialization area) and whose storage id/fingerprint are unique.
 * The provider's configured route references this exact route object.
 */
function writeParent(name: string, rootPath: string, storageId: string, fingerprint: string): void {
  mkdirSync(join(dir, "Workspace"), { recursive: true });
  writeFileSync(
    join(dir, "Workspace", `${name}.yaml`),
    `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: ${name}, labels: { twill/workspace-class: git } }
spec:
  owner: user:example
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ${rootPath}
  workspace:
    storageBacked: true
    accessMode: RWO
    storage:
      id: ${storageId}
      fingerprint: ${fingerprint}
    hostname: workstation
status: {}
`,
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "twill-loop-"));
  cpSync(fixtures, dir, { recursive: true });
  // Good baseline: drop the lineaged worktree child and give
  // workstation-repos its own fingerprint, so §8.3 sees exactly one
  // lineaged pair (payments-repo ↔ workstation-repos) and the per-test
  // parents are collision-free.
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
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
  for (const d of openDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  // reload so each test sees the fixture parents written by earlier tests
  // (the watched source accumulates; tests use unique names so no cross-talk).
  store.reload();
});

/** A claim body against `parent`, with the route + parameters. */
function claimBody(args: {
  name: string;
  parent: string;
  route: Route;
  parameters?: Record<string, string>;
  storageId: string;
  fingerprint: string;
}): unknown {
  return {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Claim",
    metadata: { name: args.name },
    spec: {
      owner: "user:test",
      routes: [],
      claim: {
        storageBacked: false,
        id: `cl_test-${args.name}`,
        principal: "pi/test@workstation",
        route: args.route,
        ...(args.parameters !== undefined ? { parameters: args.parameters } : {}),
        claimedOn: { fingerprint: args.fingerprint, durable_id: args.storageId },
      },
      parent: { kind: "Workspace", name: args.parent },
    },
    status: {},
  };
}

async function postClaim(body: unknown, name: string): Promise<Response> {
  return fetch(`${registry}/Claim/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getWorkspace(name: string): Promise<{ status: number; body?: Record<string, unknown> }> {
  const res = await fetch(`${registry}/Workspace/${name}`);
  if (res.status === 404) return { status: 404 };
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Read a Workspace's status surface via resolve (the only HTTP status read
 *  surface; the raw GET envelope's `status` is reader-ignored and never
 *  reflects provider reports). The test consumer matches every fixture route
 *  (`match: {agentLocation: workstation}` or no match). */
async function getStatus(name: string): Promise<{ ready?: boolean; progress?: string }> {
  const res = await fetch(`${registry}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "Workspace",
      name,
      consumer: { agentLocation: "workstation", agentKind: "", principal: "" },
    }),
  });
  if (!res.ok) return {};
  const body = (await res.json()) as {
    result?: string;
    descriptor?: { status?: { ready?: unknown; progress?: unknown } };
  };
  if (body.result !== "Attached") return {};
  const status = body.descriptor?.status;
  if (typeof status !== "object" || status === null) return {};
  return {
    ready: typeof status.ready === "boolean" ? status.ready : undefined,
    progress: typeof status.progress === "string" ? status.progress : undefined,
  };
}

/** The provider's route for a parent: the parent's local route with a gitClone precondition. */
function parentRoute(rootPath: string, origin: string): Route {
  return {
    match: { agentLocation: "workstation" },
    type: "local",
    path: rootPath,
    precondition: { steps: [{ type: "gitClone", url: origin, ref: "main" }] },
  };
}

describe("provider loop — claim matching and fulfillment", () => {
  it(
    "route-mismatch: a claim whose route matches no configured route is ignored (no materialization, no statusReport)",
    async () => {
      const parent = "p-mismatch";
      writeParent(parent, join(dir, "mismatch-root"), "ws_mismatch", "vol-mismatch-01");
      store.reload();
      const { origin } = await gitFixture();
      // The provider owns a DIFFERENT route than the claim carries.
      const claimRoute: Route = { match: { agentLocation: "workstation" }, type: "local", path: "/somewhere-else" };
      const created = await postClaim(
        claimBody({
          name: "claim-mismatch",
          parent,
          route: claimRoute,
          parameters: { worktreeName: "wt-mismatch" },
          storageId: "ws_mismatch",
          fingerprint: "vol-mismatch-01",
        }),
        "claim-mismatch",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(join(dir, "mismatch-root"), origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        await delay(400);
        // No child, no statusReport against the parent: the parent's status
        // surface is still the never-observed default (a report would have
        // replaced the default progress string).
        expect((await getWorkspace(`${parent}-wt-mismatch`)).status).toBe(404);
        const status = await getStatus(parent);
        expect(status.progress).toBe("no provider report yet");
        expect(existsSync(join(dir, "mismatch-root", ".twill", parent))).toBe(false);
      } finally {
        provider.stop();
      }
    },
    30_000,
  );

  it(
    "worktree claim: child appears in the overlay with ready:true, parent state restored",
    async () => {
      const parent = "p-worktree";
      const rootPath = join(dir, "worktree-root");
      writeParent(parent, rootPath, "ws_worktree", "vol-worktree-01");
      store.reload();
      const { origin } = await gitFixture();

      const created = await postClaim(
        claimBody({
          name: "claim-worktree",
          parent,
          route: parentRoute(rootPath, origin),
          parameters: { worktreeName: "wt-a" },
          storageId: "ws_worktree",
          fingerprint: "vol-worktree-01",
        }),
        "claim-worktree",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(rootPath, origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        // Poll until the child exists and is ready (or time out).
        let child: { status: number; body?: Record<string, unknown> } = { status: 404 };
        for (let i = 0; i < 100; i++) {
          child = await getWorkspace(`${parent}-wt-a`);
          const status = child.body?.["status"];
          if (child.status === 200 && typeof status === "object" && status !== null && (status as Record<string, unknown>)["ready"] === true) break;
          await delay(50);
        }
        expect(child.status).toBe(200);
        const body = child.body as Record<string, unknown>;
        const metadata = body["metadata"] as Record<string, unknown>;
        expect(metadata["name"]).toBe(`${parent}-wt-a`);
        const spec = body["spec"] as Record<string, unknown>;
        expect(spec["parent"]).toEqual({ kind: "Workspace", name: parent });
        const workspace = spec["workspace"] as Record<string, unknown>;
        expect((workspace["storage"] as Record<string, unknown>)["id"]).toBe(`ws_worktree-wt-a`);
        expect((workspace["storage"] as Record<string, unknown>)["fingerprint"]).toBe("vol-worktree-01");
        // Route copied with the materialized path, precondition dropped, match/type preserved.
        const routes = spec["routes"] as Array<Record<string, unknown>>;
        expect(routes).toHaveLength(1);
        expect(routes[0]?.["type"]).toBe("local");
        expect(routes[0]?.["match"]).toEqual({ agentLocation: "workstation" });
        expect(routes[0]?.["precondition"]).toBeUndefined();
        expect(typeof routes[0]?.["path"]).toBe("string");
        // The materialized path exists on disk.
        expect(existsSync(routes[0]?.["path"] as string)).toBe(true);
        // Child ready:true; parent restored (the fixture parent has no prior
        // status, so the restored state is the never-observed default: ready
        // false, no progress).
        const childStatus = await getStatus(`${parent}-wt-a`);
        expect(childStatus.ready).toBe(true);
        const parentStatus = await getStatus(parent);
        expect(parentStatus.ready).toBe(false);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "cold-root claim (no worktreeName): parent materialized, ready:true on the parent, no child",
    async () => {
      const parent = "p-coldroot";
      const rootPath = join(dir, "coldroot-root");
      writeParent(parent, rootPath, "ws_coldroot", "vol-coldroot-01");
      store.reload();
      const { origin } = await gitFixture();

      const created = await postClaim(
        claimBody({
          name: "claim-coldroot",
          parent,
          route: parentRoute(rootPath, origin),
          storageId: "ws_coldroot",
          fingerprint: "vol-coldroot-01",
        }),
        "claim-coldroot",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(rootPath, origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(parent);
          if (status.ready === true) {
            ready = true;
            break;
          }
          await delay(50);
        }
        expect(ready).toBe(true);
        // No child named <parent>-anything appeared.
        const discovery = (await (await fetch(registry)).json()) as Array<Record<string, unknown>>;
        expect(discovery.some((row) => row["kind"] === "Workspace" && String(row["name"]).startsWith(`${parent}-`))).toBe(false);
        // The parent was materialized on disk (the clone landed).
        expect(existsSync(join(rootPath, ".twill", parent, "main"))).toBe(true);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "failure: a claim whose step fails reports progress and never writes a child",
    async () => {
      const parent = "p-failure";
      const rootPath = join(dir, "failure-root");
      writeParent(parent, rootPath, "ws_failure", "vol-failure-01");
      store.reload();
      // The gitClone points at a nonexistent origin — the step fails.
      const badRoute: Route = {
        match: { agentLocation: "workstation" },
        type: "local",
        path: rootPath,
        precondition: { steps: [{ type: "gitClone", url: "/nonexistent/origin.git", ref: "main" }] },
      };
      const created = await postClaim(
        claimBody({
          name: "claim-failure",
          parent,
          route: badRoute,
          parameters: { worktreeName: "wt-fail" },
          storageId: "ws_failure",
          fingerprint: "vol-failure-01",
        }),
        "claim-failure",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({ registry, routes: [badRoute], parents: [parent], pollIntervalMs: 50 });
      try {
        // Wait until the failure progress names the bad origin (the never-
        // observed default is "no provider report yet", so a real report is
        // distinguishable by its content).
        let sawProgress = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(parent);
          if (status.progress !== undefined && status.progress.includes("nonexistent") && status.ready === false) {
            sawProgress = true;
            break;
          }
          await delay(50);
        }
        expect(sawProgress).toBe(true);
        expect((await getWorkspace(`${parent}-wt-fail`)).status).toBe(404);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "idempotence: a re-polled fulfilled claim is a no-op (no re-materialization)",
    async () => {
      const parent = "p-idem";
      const rootPath = join(dir, "idem-root");
      writeParent(parent, rootPath, "ws_idem", "vol-idem-01");
      store.reload();
      const { origin } = await gitFixture();

      const created = await postClaim(
        claimBody({
          name: "claim-idem",
          parent,
          route: parentRoute(rootPath, origin),
          parameters: { worktreeName: "wt-idem" },
          storageId: "ws_idem",
          fingerprint: "vol-idem-01",
        }),
        "claim-idem",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(rootPath, origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        // Wait for the child to become ready (first fulfillment).
        let childReady = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(`${parent}-wt-idem`);
          if (status.ready === true) {
            childReady = true;
            break;
          }
          await delay(50);
        }
        expect(childReady).toBe(true);
        // The claim carries worktreeName=wt-idem, so the gitClone placement is
        // <workDir>/wt-idem (the child path), where workDir = <route.path>/.twill/<parent>.
        const childPath = join(rootPath, ".twill", parent, "wt-idem");
        const before = existsSync(childPath) ? readFileSync(join(childPath, "f.txt"), "utf8") : "";
        expect(before).toBe("v1\n");
        // Keep polling: a re-polled fulfilled claim is skipped — the child
        // stays exactly as materialized (no error, no churn).
        await delay(400);
        expect((await getStatus(`${parent}-wt-idem`)).ready).toBe(true);
        expect(existsSync(childPath)).toBe(true);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "invalid worktreeName (path-unsafe) is rejected with progress naming the parameter; no materialization",
    async () => {
      const parent = "p-unsafe";
      const rootPath = join(dir, "unsafe-root");
      writeParent(parent, rootPath, "ws_unsafe", "vol-unsafe-01");
      store.reload();
      const { origin } = await gitFixture();

      const created = await postClaim(
        claimBody({
          name: "claim-unsafe",
          parent,
          route: parentRoute(rootPath, origin),
          parameters: { worktreeName: "../escape" },
          storageId: "ws_unsafe",
          fingerprint: "vol-unsafe-01",
        }),
        "claim-unsafe",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(rootPath, origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        let sawRejection = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(parent);
          if (status.progress !== undefined && status.progress.includes("worktreeName")) {
            sawRejection = true;
            break;
          }
          await delay(50);
        }
        expect(sawRejection).toBe(true);
        // Nothing materialized outside the placement root.
        expect(existsSync(join(dir, "escape"))).toBe(false);
        expect(existsSync(join(rootPath, ".twill", parent, "main"))).toBe(false);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "cold-root idempotence: an already-ready parent is skipped on re-poll (a broken origin cannot flap it)",
    async () => {
      const parent = "p-coldskip";
      const rootPath = join(dir, "coldskip-root");
      writeParent(parent, rootPath, "ws_coldskip", "vol-coldskip-01");
      store.reload();
      const { origin } = await gitFixture();

      const created = await postClaim(
        claimBody({
          name: "claim-coldskip",
          parent,
          route: parentRoute(rootPath, origin),
          storageId: "ws_coldskip",
          fingerprint: "vol-coldskip-01",
        }),
        "claim-coldskip",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({
        registry,
        routes: [parentRoute(rootPath, origin)],
        parents: [parent],
        pollIntervalMs: 50,
      });
      try {
        // Wait for the cold-root fulfillment: parent ready:true, clone on disk.
        let ready = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(parent);
          if (status.ready === true) {
            ready = true;
            break;
          }
          await delay(50);
        }
        expect(ready).toBe(true);
        expect(existsSync(join(rootPath, ".twill", parent, "main"))).toBe(true);

        // Break the origin: a re-run of the gitClone step would fail its
        // fetch. A fulfilled cold-root claim must be a no-op on re-poll
        // (spec §6), so the parent stays ready across subsequent polls and
        // no failure progress ever lands — no consumer-visible flapping on
        // a transient origin outage.
        renameSync(origin, `${origin}.broken`);
        for (let i = 0; i < 8; i++) {
          await delay(60);
          const status = await getStatus(parent);
          expect(status.ready).toBe(true);
          // A re-run that failed would have replaced the never-observed
          // default progress with the fetch error.
          expect(status.progress).toBe("no provider report yet");
        }
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "non-local route guard: an ssh route carrying a path fails loud (progress names the route type), no local materialization",
    async () => {
      const parent = "p-sshroute";
      const rootPath = join(dir, "sshroute-root");
      writeParent(parent, rootPath, "ws_sshroute", "vol-sshroute-01");
      store.reload();
      const { origin } = await gitFixture();

      // A misconfigured non-local route that CARRIES a path: the provider
      // must refuse to materialize it locally at the remote path.
      const sshRoute: Route = {
        match: { agentLocation: "workstation" },
        type: "ssh",
        host: "example.invalid",
        path: rootPath,
        precondition: { steps: [{ type: "gitClone", url: origin, ref: "main" }] },
      };
      const created = await postClaim(
        claimBody({
          name: "claim-sshroute",
          parent,
          route: sshRoute,
          parameters: { worktreeName: "wt-ssh" },
          storageId: "ws_sshroute",
          fingerprint: "vol-sshroute-01",
        }),
        "claim-sshroute",
      );
      expect(created.status).toBe(201);

      const provider = startProvider({ registry, routes: [sshRoute], parents: [parent], pollIntervalMs: 50 });
      try {
        let sawGuard = false;
        for (let i = 0; i < 100; i++) {
          const status = await getStatus(parent);
          if (status.ready === false && status.progress !== undefined && status.progress.includes("ssh")) {
            sawGuard = true;
            break;
          }
          await delay(50);
        }
        expect(sawGuard).toBe(true);
        // Nothing materialized at the route's path, no child written.
        expect(existsSync(join(rootPath, ".twill", parent))).toBe(false);
        expect((await getWorkspace(`${parent}-wt-ssh`)).status).toBe(404);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );

  it(
    "serial-per-parent: two claims against one parent fulfill one at a time, both complete",
    async () => {
      const parent = "p-serial";
      const rootPath = join(dir, "serial-root");
      writeParent(parent, rootPath, "ws_serial", "vol-serial-01");
      store.reload();
      const { origin } = await gitFixture();
      // Two gitClone-only claims against the same parent. Each lands at
      // .twill/<parent>/<worktreeName> (a dedicated clone per claim), so both
      // succeed. Serially queued on the parent's chain, both complete — the
      // serial-per-parent guarantee (two fulfillments, one parent, no race).
      const mkRoute = (): Route => ({
        match: { agentLocation: "workstation" },
        type: "local",
        path: rootPath,
        precondition: { steps: [{ type: "gitClone", url: origin, ref: "main" }] },
      });
      const route = mkRoute();

      const first = await postClaim(
        claimBody({
          name: "claim-serial-1",
          parent,
          route,
          parameters: { worktreeName: "wt-1" },
          storageId: "ws_serial",
          fingerprint: "vol-serial-01",
        }),
        "claim-serial-1",
      );
      expect(first.status).toBe(201);
      const second = await postClaim(
        claimBody({
          name: "claim-serial-2",
          parent,
          route,
          parameters: { worktreeName: "wt-2" },
          storageId: "ws_serial",
          fingerprint: "vol-serial-01",
        }),
        "claim-serial-2",
      );
      expect(second.status).toBe(201);

      const provider = startProvider({ registry, routes: [route], parents: [parent], pollIntervalMs: 50 });
      try {
        let both = false;
        for (let i = 0; i < 200; i++) {
          const a = await getStatus(`${parent}-wt-1`);
          const b = await getStatus(`${parent}-wt-2`);
          if (a.ready === true && b.ready === true) {
            both = true;
            break;
          }
          await delay(50);
        }
        expect(both).toBe(true);
        // Both children materialized as distinct clones.
        expect(existsSync(join(rootPath, ".twill", parent, "wt-1"))).toBe(true);
        expect(existsSync(join(rootPath, ".twill", parent, "wt-2"))).toBe(true);
      } finally {
        provider.stop();
      }
    },
    60_000,
  );
});
