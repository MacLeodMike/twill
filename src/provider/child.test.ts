// Child document construction tests (T2.5 Task 4) — the deterministic
// §5.3 rules as a pure function, plus the one integration assertion that
// matters: the constructed child passes §8.3 lineage when PATCHed into a
// real in-process store/overlay (parent present → ancestor sets intersect
// → no fingerprint-collision reject).
//
// The unit tests pin the pure-function contract (Review Focus #3: a
// duplicate claim upserts/converges, never diverges): same (parent,
// worktreeName) → same name and id on EVERY call; nothing else (not the
// materialized path, not the call count) feeds identity.
//
// The integration test boots a real store + server over a tmpdir with a
// single parent Workspace fixture (the upsert.test.ts harness pattern) and
// PATCHes the constructed child over HTTP — the exact write the provider
// loop performs. A stripped-parent control proves the acceptance rests on
// the lineage link, not on the harness being permissive.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { start, type RegistryStore } from "../registry/store.js";
import { createServer } from "../registry/server.js";
import { API_VERSION, type Route } from "../registry/document.js";
import { buildChildDocument, childNameFor, type ClaimEnvelope } from "./child.js";

const PARENT_NAME = "payments-repo";
const PARENT_STORAGE_ID = "ws_01J8Z4-payments-repo";
const PARENT_FINGERPRINT = "vol-2c4f1a";
const WORKTREE_NAME = "feat-x";
const CHILD_PATH = "/materialized/payments-repo/feat-x";

/** A parent Workspace envelope as GET /Workspace/<name> serves it (doc.raw). */
function parentEnvelope(): Record<string, unknown> {
  return {
    apiVersion: API_VERSION,
    kind: "Workspace",
    metadata: { name: PARENT_NAME, labels: { "twill/workspace-class": "git" } },
    spec: {
      owner: "user:example",
      routes: [{ match: { agentLocation: "workstation" }, type: "local", path: "~/repos/payments-repo" }],
      workspace: {
        storageBacked: true,
        accessMode: "RWO",
        storage: { id: PARENT_STORAGE_ID, fingerprint: PARENT_FINGERPRINT },
        hostname: "workstation",
      },
    },
    status: {},
  };
}

/** The claim route a consumer copied verbatim from the resolved parent route. */
function claimRoute(): Route {
  return {
    match: { agentLocation: "workstation", agentKind: "pi" },
    type: "local",
    path: "~/repos/payments-repo",
    precondition: { steps: [{ type: "worktree", repo: ".", branch: "{{claim.parameters.branch}}" }] },
  };
}

/** A claim envelope as GET /claims serves it (only the fields the builder reads are required). */
function claimEnvelope(args: { route?: unknown; worktreeName?: string }): ClaimEnvelope {
  const parameters: Record<string, string> = { branch: "feat-x" };
  if (args.worktreeName !== undefined) parameters["worktreeName"] = args.worktreeName;
  return {
    metadata: { name: "claim-feat-x" },
    spec: {
      parent: { kind: "Workspace", name: PARENT_NAME },
      claim: {
        ...(args.route !== undefined ? { route: args.route } : {}),
        parameters,
      },
    },
  };
}

/** Read a nested path from a record tree (test-local projection helper). */
function dig(doc: Record<string, unknown>, ...path: string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("buildChildDocument — deterministic identity (Review Focus #3)", () => {
  it("same (parent, worktreeName) yields the same name and storage id on every call", () => {
    const parent = parentEnvelope();
    const claim = claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME });

    const first = buildChildDocument(parent, claim, CHILD_PATH);
    const second = buildChildDocument(parent, claim, CHILD_PATH);
    const third = buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME }), CHILD_PATH);

    // The name/id are a pure function of (parent, worktreeName): identical
    // across calls and across fresh-but-equal inputs (a duplicate claim
    // re-yields the same child — the PATCH upsert converges).
    for (const doc of [second, third]) {
      expect(dig(doc, "metadata", "name")).toBe(dig(first, "metadata", "name"));
      expect(dig(doc, "spec", "workspace", "storage", "id")).toBe(dig(first, "spec", "workspace", "storage", "id"));
      expect(doc).toEqual(first);
    }
    expect(dig(first, "metadata", "name")).toBe(`${PARENT_NAME}-${WORKTREE_NAME}`);
    expect(dig(first, "spec", "workspace", "storage", "id")).toBe(`${PARENT_STORAGE_ID}-${WORKTREE_NAME}`);
    // The loop's idempotence check and PATCH URL share the same derivation.
    expect(childNameFor(PARENT_NAME, WORKTREE_NAME)).toBe(dig(first, "metadata", "name"));
  });

  it("identity depends on (parent, worktreeName) only — not on the materialized path", () => {
    const a = buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME }), "/path/one");
    const b = buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME }), "/path/two");
    expect(dig(a, "metadata", "name")).toBe(dig(b, "metadata", "name"));
    expect(dig(a, "spec", "workspace", "storage", "id")).toBe(dig(b, "spec", "workspace", "storage", "id"));

    const other = buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute(), worktreeName: "feat-y" }), CHILD_PATH);
    expect(dig(other, "metadata", "name")).toBe(`${PARENT_NAME}-feat-y`);
    expect(dig(other, "spec", "workspace", "storage", "id")).toBe(`${PARENT_STORAGE_ID}-feat-y`);
  });
});

describe("buildChildDocument — the §5.3 construction rules", () => {
  it("copies the claim route with path replaced, precondition dropped, match/type preserved exactly", () => {
    const route = claimRoute();
    const claim = claimEnvelope({ route, worktreeName: WORKTREE_NAME });
    const child = buildChildDocument(parentEnvelope(), claim, CHILD_PATH);

    const routes = dig(child, "spec", "routes") as Array<Record<string, unknown>>;
    expect(routes).toHaveLength(1);
    const childRoute = routes[0]!;
    expect(childRoute["path"]).toBe(CHILD_PATH);
    expect("precondition" in childRoute).toBe(false);
    expect(childRoute["match"]).toEqual(route["match"]);
    expect(childRoute["type"]).toBe(route["type"]);

    // The builder does not mutate its inputs: the claim's route keeps its
    // original path and precondition.
    expect(route["path"]).toBe("~/repos/payments-repo");
    expect(route["precondition"]).toEqual({
      steps: [{ type: "worktree", repo: ".", branch: "{{claim.parameters.branch}}" }],
    });
  });

  it("links the parent: spec.parent points at the parent, fingerprint inherited", () => {
    const child = buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME }), CHILD_PATH);

    expect(dig(child, "spec", "parent")).toEqual({ kind: "Workspace", name: PARENT_NAME });
    expect(dig(child, "spec", "workspace", "storage", "fingerprint")).toBe(PARENT_FINGERPRINT);
    // The rest of the parent's workspace class and ownership carry over.
    expect(dig(child, "spec", "workspace", "hostname")).toBe("workstation");
    expect(dig(child, "spec", "workspace", "storageBacked")).toBe(true);
    expect(dig(child, "spec", "owner")).toBe("user:example");
    expect(dig(child, "metadata", "labels")).toEqual({ "twill/workspace-class": "git" });
    // The envelope is a well-formed Workspace document.
    expect(child["apiVersion"]).toBe(API_VERSION);
    expect(child["kind"]).toBe("Workspace");
  });

  it("rejects a claim with no worktreeName (cold-root claims build no child)", () => {
    expect(() => buildChildDocument(parentEnvelope(), claimEnvelope({ route: claimRoute() }), CHILD_PATH)).toThrow(
      /worktreeName/,
    );
  });

  it("rejects a claim with no route", () => {
    expect(() =>
      buildChildDocument(parentEnvelope(), claimEnvelope({ worktreeName: WORKTREE_NAME }), CHILD_PATH),
    ).toThrow(/route/);
  });

  it("rejects a parent envelope with no metadata.name", () => {
    const parent = parentEnvelope();
    parent["metadata"] = {};
    expect(() =>
      buildChildDocument(parent, claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME }), CHILD_PATH),
    ).toThrow(/metadata\.name/);
  });
});

describe("buildChildDocument — §8.3 lineage against a real store", () => {
  const openStores: RegistryStore[] = [];
  const openServers: Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const server of openServers.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()));
    }
    for (const store of openStores.splice(0)) store.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Boot a real registry (store + server) over a tmpdir holding one parent Workspace. */
  async function boot(): Promise<{ base: string }> {
    const dir = mkdtempSync(join(tmpdir(), "twill-child-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "Workspace"), { recursive: true });
    writeFileSync(
      join(dir, "Workspace", `${PARENT_NAME}.yaml`),
      `apiVersion: ${API_VERSION}
kind: Workspace
metadata: { name: ${PARENT_NAME}, labels: { twill/workspace-class: git } }
spec:
  owner: user:example
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos/payments-repo
  workspace:
    storageBacked: true
    accessMode: RWO
    storage:
      id: ${PARENT_STORAGE_ID}
      fingerprint: ${PARENT_FINGERPRINT}
    hostname: workstation
status: {}
`,
    );
    const store = start(dir);
    openStores.push(store);
    const server = createServer(store);
    openServers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { base: `http://127.0.0.1:${port}/twill/v1alpha1` };
  }

  async function patch(base: string, name: string, doc: unknown): Promise<{ status: number; error?: string }> {
    const res = await fetch(`${base}/Workspace/${name}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    const body = (await res.json()) as { error?: string };
    return { status: res.status, error: body.error };
  }

  it(
    "the constructed child PATCHes cleanly (parent present → lineage pass) and a duplicate converges",
    async () => {
      const { base } = await boot();

      // The parent envelope exactly as the provider loop reads it.
      const parentRes = await fetch(`${base}/Workspace/${PARENT_NAME}`);
      expect(parentRes.status).toBe(200);
      const parentDoc = (await parentRes.json()) as Record<string, unknown>;

      const claim = claimEnvelope({ route: claimRoute(), worktreeName: WORKTREE_NAME });
      const child = buildChildDocument(parentDoc, claim, CHILD_PATH);
      const childName = dig(child, "metadata", "name") as string;

      // THE lineage assertion: parent present, child shares its fingerprint
      // and names it via spec.parent → ancestor sets intersect → no §8.3
      // fingerprint-collision reject.
      const first = await patch(base, childName, child);
      expect(first.status).toBe(200);

      // Review Focus #3: a duplicate claim re-yields the same child — the
      // re-PATCH is an upsert (replace-by-name), never a duplicate-id
      // collision, and the registry holds exactly one such document.
      const second = await patch(base, childName, buildChildDocument(parentDoc, claim, CHILD_PATH));
      expect(second.status).toBe(200);
      const discovery = (await (await fetch(base)).json()) as Array<Record<string, unknown>>;
      expect(discovery.filter((row) => row["kind"] === "Workspace" && row["name"] === childName)).toHaveLength(1);

      // The stored child round-trips with the §5.3 shape intact.
      const gotRes = await fetch(`${base}/Workspace/${childName}`);
      expect(gotRes.status).toBe(200);
      const got = (await gotRes.json()) as Record<string, unknown>;
      expect(dig(got, "spec", "parent")).toEqual({ kind: "Workspace", name: PARENT_NAME });
      expect(dig(got, "spec", "workspace", "storage", "id")).toBe(`${PARENT_STORAGE_ID}-${WORKTREE_NAME}`);
      expect(dig(got, "spec", "workspace", "storage", "fingerprint")).toBe(PARENT_FINGERPRINT);

      // Control: the same child WITHOUT the parent link is a fingerprint
      // collision without lineage → 409, nothing persisted (proves the
      // acceptance above rests on the lineage link, not on a permissive
      // harness).
      const orphan = structuredClone(child) as Record<string, unknown>;
      delete (orphan["spec"] as Record<string, unknown>)["parent"];
      const rejected = await patch(base, childName, orphan);
      expect(rejected.status).toBe(409);
      expect(rejected.error).toContain("fingerprint collision without lineage");

      // The rejection persisted nothing: the stored child still carries its
      // parent link.
      const afterRes = await fetch(`${base}/Workspace/${childName}`);
      const after = (await afterRes.json()) as Record<string, unknown>;
      expect(dig(after, "spec", "parent")).toEqual({ kind: "Workspace", name: PARENT_NAME });
    },
    30_000,
  );
});
