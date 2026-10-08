// Overlay upsert tests (t25 Task 1) — PATCH /twill/v1alpha1/<kind>/<name>
// for non-Claim kinds (workspace §8: "PATCH is upsert on the document
// surface; writes are validated before append — a write whose merged
// result would violate §8.3 is rejected with an error to the writer,
// never persisted"). Claim PATCH stays on T2a's release-only path; the
// claim collision rule still routes it there, never through the upsert.
//
// Servers boot on an ephemeral port over a fixture-backed temp-dir store
// (the claims.test.ts pattern); bodies are JSON (the claims write
// surfaces are JSON too — the registry serves YAML only from the watched
// source). Servers, stores, and temp dirs are closed/removed in
// afterEach so vitest exits cleanly.

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { start, type RegistryStore } from "./store.js";
import { createServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openStores: RegistryStore[] = [];
const openServers: Server[] = [];
const tempDirs: string[] = [];

/**
 * The default boot baseline: drop the lineaged worktree child and give
 * workstation-repos its own fingerprint (vol-wsr-01). Payments-repo keeps
 * its fixture lineage (fingerprint vol-2c4f1a, parent workstation-repos),
 * so §8.3 sees exactly one lineaged fingerprint pair and every non-lineage
 * collision test can target vol-wsr-01 deterministically (a rejected
 * merged set reports the FIRST §8.3 violation — keeping each bad PATCH
 * single-violation keeps the asserted reasons stable).
 */
function tempDocuments(mutate?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-upsert-"));
  cpSync(fixtures, dir, { recursive: true });
  rmSync(join(dir, "Workspace", "payments-repo-feat-x.yaml"), { force: true });
  const wsr = join(dir, "Workspace", "workstation-repos.yaml");
  writeFileSync(wsr, readFileSync(wsr, "utf8").replace("vol-2c4f1a", "vol-wsr-01"));
  mutate?.(dir);
  tempDirs.push(dir);
  return dir;
}

type Boot = { base: string; store: RegistryStore; dir: string };

/** Boot a server on an ephemeral port over a fixture-backed temp-dir store. */
async function boot(mutate?: (dir: string) => void): Promise<Boot> {
  const dir = tempDocuments(mutate);
  const store = start(dir);
  openStores.push(store);
  const server = createServer(store);
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/twill/v1alpha1`, store, dir };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A valid Workspace body (the §5.3 child shape): parent + shared fingerprint = the lineage pass. */
function workspaceBody(
  name: string,
  overrides?: { fingerprint?: string; storageId?: string; parent?: unknown },
): unknown {
  const spec: Record<string, unknown> = {
    owner: "user:example",
    routes: [
      {
        match: { agentLocation: "workstation" },
        type: "local",
        path: "~/repos/payments-repo/wt/feat-x",
      },
    ],
    workspace: {
      storageBacked: true,
      accessMode: "RWO",
      storage: {
        id: overrides?.storageId ?? `ws_test-${name}`,
        fingerprint: overrides?.fingerprint ?? "vol-wsr-01",
      },
    },
    parent: overrides && "parent" in overrides ? overrides.parent : { kind: "Workspace", name: "workstation-repos" },
  };
  return {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Workspace",
    metadata: { name },
    spec,
    status: {},
  };
}

/** A valid claim body against payments-repo (claims.test.ts's shape, minimal). */
function claimBody(name: string): unknown {
  return {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Claim",
    metadata: { name },
    spec: {
      owner: "user:example",
      routes: [],
      claim: {
        storageBacked: false,
        id: `cl_test-${name}`,
        principal: "pi/0.99.1@workstation",
        route: { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/payments-repo" },
        parameters: { branch: "feat-x", worktreeName: "feat-x" },
        claimedOn: { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-payments-repo" },
      },
      parent: { kind: "Workspace", name: "payments-repo" },
    },
    status: {},
  };
}

async function patch(base: string, kind: string, name: string, body: unknown): Promise<Response> {
  return fetch(`${base}/${kind}/${name}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /<kind>/<name> — overlay upsert (t25 Task 1; workspace §8 write-time validation)", () => {
  it("(a) upsert create: PATCH against a not-yet-existing name → 200, the verbatim envelope, immediately readable + persisted; a same-name re-PATCH updates", async () => {
    const { base, store, dir } = await boot();
    const res = await patch(base, "Workspace", "payments-repo-feat-x", workspaceBody("payments-repo-feat-x"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      kind: string;
      metadata: { name: string };
      spec: { parent: { kind: string; name: string }; workspace: { storage: { fingerprint: string; id: string } } };
    };
    // The served document is the stored raw envelope, verbatim.
    expect(doc.kind).toBe("Workspace");
    expect(doc.metadata.name).toBe("payments-repo-feat-x");
    expect(doc.spec.parent).toEqual({ kind: "Workspace", name: "workstation-repos" });
    expect(doc.spec.workspace.storage).toEqual({ id: "ws_test-payments-repo-feat-x", fingerprint: "vol-wsr-01" });

    // Immediately in the merged snapshot and over GET — no reload needed.
    expect(store.get("Workspace", "payments-repo-feat-x")?.kindSpec["storage"]).toEqual({
      id: "ws_test-payments-repo-feat-x",
      fingerprint: "vol-wsr-01",
    });
    const got = await fetch(`${base}/Workspace/payments-repo-feat-x`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { metadata: { name: string } }).metadata.name).toBe("payments-repo-feat-x");

    // Persisted: the overlay file exists beside the documents with the line appended.
    const overlayText = readFileSync(join(dir, ".twill-overlay.jsonl"), "utf8");
    expect(overlayText).toContain('"payments-repo-feat-x"');

    // Upsert, not insert: a same-name PATCH replaces (latest-per-name) —
    // still exactly one document of that name, now carrying the new id.
    const updated = await patch(
      base,
      "Workspace",
      "payments-repo-feat-x",
      workspaceBody("payments-repo-feat-x", { storageId: "ws_test-feat-x-v2" }),
    );
    expect(updated.status).toBe(200);
    expect(store.get("Workspace", "payments-repo-feat-x")?.kindSpec["storage"]).toMatchObject({
      id: "ws_test-feat-x-v2",
    });
    expect(store.current().documents.filter((d) => d.kind === "Workspace" && d.name === "payments-repo-feat-x")).toHaveLength(1);
  });

  it("(b) fingerprint collision without lineage → 409 (Review Focus #4): nothing persisted, the served set is unchanged", async () => {
    const { base, store, dir } = await boot();
    // workstation-repos' fingerprint (vol-wsr-01) under a new name with NO
    // parent link → §8.3's fingerprint-collision-without-lineage rule
    // rejects the merged set (payments-repo/vol-2c4f1a stays lineaged and
    // out of the way, so the collision is the set's only violation).
    const res = await patch(base, "Workspace", "rogue-child", workspaceBody("rogue-child", { parent: undefined }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("fingerprint collision");

    // Overlay untouched: no document, and the overlay file was never
    // created (it appears only on the first ACCEPTED append).
    expect(store.get("Workspace", "rogue-child")).toBeUndefined();
    expect(existsSync(join(dir, ".twill-overlay.jsonl"))).toBe(false);
    expect(store.health()).toEqual({ documentSet: "current", warnings: [] });
    expect(store.get("Workspace", "payments-repo")).toBeDefined();
  });

  it("(c) §8.3 duplicates and cycles also reject 409 with the overlay untouched", async () => {
    const { base, store } = await boot();
    // Duplicate durable id: workstation-repos' storage id under a new name,
    // with a fresh non-colliding fingerprint so the durable-id rule is the
    // set's only violation (the reason is deterministic).
    const dup = await patch(
      base,
      "Workspace",
      "dup-id",
      workspaceBody("dup-id", { storageId: "ws_01J8Z4-workstation-repos", fingerprint: "vol-dup", parent: undefined }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toContain("duplicate durable id");
    expect(store.get("Workspace", "dup-id")).toBeUndefined();

    // Parent cycle: self-parenting document.
    const cyc = await patch(base, "Workspace", "loopy", workspaceBody("loopy", { parent: { kind: "Workspace", name: "loopy" } }));
    expect(cyc.status).toBe(409);
    expect(((await cyc.json()) as { error: string }).error).toContain("cycle");
    expect(store.get("Workspace", "loopy")).toBeUndefined();
  });

  it("(d) URL/document mismatches → 400: the URL kind must equal body kind, the URL name must equal metadata.name", async () => {
    const { base, store } = await boot();
    // Kind mismatch: PATCH /Card/<name> carrying a Workspace envelope.
    const kindMismatch = await patch(base, "Card", "payments-repo-feat-x", workspaceBody("payments-repo-feat-x"));
    expect(kindMismatch.status).toBe(400);
    expect(((await kindMismatch.json()) as { error: string }).error).toContain("kind");

    // Name mismatch: URL name ≠ metadata.name.
    const nameMismatch = await patch(base, "Workspace", "other-name", workspaceBody("payments-repo-feat-x"));
    expect(nameMismatch.status).toBe(400);
    expect(((await nameMismatch.json()) as { error: string }).error).toContain("metadata.name");

    expect(store.get("Workspace", "payments-repo-feat-x")).toBeUndefined();
    expect(store.get("Workspace", "other-name")).toBeUndefined();
  });

  it("(e) malformed bodies → 400: non-JSON text, wrong apiVersion, non-object envelope", async () => {
    const { base, store } = await boot();
    const nonJson = await patch(base, "Workspace", "ws-x", "{not json");
    expect(nonJson.status).toBe(400);
    expect(((await nonJson.json()) as { error: string }).error).toContain("malformed JSON");

    const wrongVersion = await patch(base, "Workspace", "ws-x", {
      ...(workspaceBody("ws-x") as Record<string, unknown>),
      apiVersion: "v2",
    });
    expect(wrongVersion.status).toBe(400);
    expect(((await wrongVersion.json()) as { error: string }).error).toContain("apiVersion");

    const arrayBody = await patch(base, "Workspace", "ws-x", [1, 2, 3]);
    expect(arrayBody.status).toBe(400);
    expect(store.get("Workspace", "ws-x")).toBeUndefined();
  });

  it("(f) Claim PATCH stays release-only (T2a's rule): a mutation beyond spec.claim.released → 409, the claim untouched — never the upsert path", async () => {
    const { base, store } = await boot();
    const created = await fetch(`${base}/Claim/claim-upsert-guard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claimBody("claim-upsert-guard")),
    });
    expect(created.status).toBe(201);

    // A PATCH that changes parameters (not just released) must hit the
    // release-only 409, not silently upsert the claim through the overlay.
    const mutated = claimBody("claim-upsert-guard") as { spec: { claim: Record<string, unknown> } };
    mutated.spec.claim.released = true;
    mutated.spec.claim.parameters = { branch: "main" };
    const res = await patch(base, "Claim", "claim-upsert-guard", mutated);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("spec.claim.parameters");
    expect(store.get("Claim", "claim-upsert-guard")?.kindSpec["parameters"]).toEqual({
      branch: "feat-x",
      worktreeName: "feat-x",
    });
    expect(store.get("Claim", "claim-upsert-guard")?.kindSpec["released"]).toBe(false);
  });

  it("(g) a non-Claim kind upserts too: PATCH /Card/<name> creates the document", async () => {
    const { base, store } = await boot();
    const body = {
      apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
      kind: "Card",
      metadata: { name: "card-alpha" },
      spec: {
        owner: "user:example",
        routes: [],
        card: { id: "card_test-alpha", title: "alpha" },
      },
      status: {},
    };
    const res = await patch(base, "Card", "card-alpha", body);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { kind: string; metadata: { name: string }; spec: { card: { id: string } } };
    expect(doc.kind).toBe("Card");
    expect(doc.metadata.name).toBe("card-alpha");
    expect(doc.spec.card.id).toBe("card_test-alpha");
    expect(store.get("Card", "card-alpha")?.kindSpec["id"]).toBe("card_test-alpha");
  });

  it("(h) an overlay upsert shadowing a watched name wins the read-path and surfaces the §8 shadow warning", async () => {
    const { base, store } = await boot();
    // Re-PATCH the watched payments-repo with a fresh storage fingerprint
    // (a §8.3-clean change: no other document shares vol-shadow-01).
    const shadow = workspaceBody("payments-repo", { fingerprint: "vol-shadow-01", parent: undefined });
    const res = await patch(base, "Workspace", "payments-repo", shadow);
    expect(res.status).toBe(200);

    // The overlay version is the one served, immediately (workspace §8:
    // on name collision the overlay wins).
    expect(store.get("Workspace", "payments-repo")?.kindSpec["storage"]).toMatchObject({ fingerprint: "vol-shadow-01" });
    const got = await fetch(`${base}/Workspace/payments-repo`);
    expect(((await got.json()) as { spec: { workspace: { storage: { fingerprint: string } } } }).spec.workspace.storage.fingerprint).toBe("vol-shadow-01");

    // The shadow warning is a watched-vs-overlay comparison, so it appears
    // on the next accepted (watched) reload — not inline at append time.
    // Past the store's 100ms watcher debounce a manual reload() stands in
    // for the watcher callback (deterministic under vitest).
    await delay(150);
    store.reload();
    expect(store.health().warnings).toContainEqual({ type: "overlay-shadow", name: "Workspace/payments-repo" });
  });
});
