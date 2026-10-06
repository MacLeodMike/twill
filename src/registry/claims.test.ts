// Claim create tests (T2a Task 1) — validateClaimCreate + POST /Claim/<name>
// (core §9's claim shape + workspace §8's claim collision rule), and the
// store's overlay write seam (appendOverlay: merged-set rejectCheck before
// accept; the merged snapshot exposes overlay documents to discovery and
// resolution immediately).
//
// Stores boot on a temp copy of fixtures/documents (never the fixture dir
// itself); claim bodies are constructed in memory — no fixture files are
// added for claims. Servers and stores are closed/removed in afterEach so
// vitest exits cleanly.

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { start, type RegistryStore } from "./store.js";
import { createServer } from "./server.js";
import { validateClaimCreate, validateClaimRelease } from "./claims.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openStores: RegistryStore[] = [];
const openServers: Server[] = [];
const tempDirs: string[] = [];

/** Fresh temp dir with the fixtures copied in (plus an optional mutation). */
function tempDocuments(mutate?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-claims-"));
  cpSync(fixtures, dir, { recursive: true });
  mutate?.(dir);
  tempDirs.push(dir);
  return dir;
}

/**
 * A *good* two-document baseline (same mutation as store.test.ts's): drop
 * the worktree child, give payments-repo a distinct fingerprint, and strip
 * its parent link — payments-repo becomes a standalone root whose deletion
 * cannot trip §8.3 (the orphan-release ruling test deletes it).
 */
function tempBaseline(dir: string): void {
  rmSync(join(dir, "Workspace", "payments-repo-feat-x.yaml"), { force: true });
  const p = join(dir, "Workspace", "payments-repo.yaml");
  writeFileSync(
    p,
    readFileSync(p, "utf8")
      .replace("vol-2c4f1a", "vol-payments-01")
      .replace("  parent: { kind: Workspace, name: workstation-repos }\n", ""),
  );
}

function startStore(dir: string): RegistryStore {
  const store = start(dir);
  openStores.push(store);
  return store;
}

type Boot = { base: string; store: RegistryStore };

/** Boot a server on an ephemeral port over a fixture-backed temp-dir store. */
async function boot(): Promise<Boot> {
  const store = startStore(tempDocuments());
  const server = createServer(store);
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/twill/v1alpha1`, store };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A valid claim body against the `payments-repo` fixture (durable id
 * `ws_01J8Z4-payments-repo`, fingerprint `vol-2c4f1a` — the raw fixture
 * keeps its lineage link to workstation-repos). Field overrides go last so
 * the failure cases break exactly one rule each.
 */
function validClaimBody(name: string, overrides?: { fingerprint?: string; durableId?: string; route?: unknown }): unknown {
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
        route: overrides && "route" in overrides
          ? overrides.route
          : { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/payments-repo" },
        parameters: { branch: "feat-x", worktreeName: "feat-x" },
        claimedOn: {
          fingerprint: overrides?.fingerprint ?? "vol-2c4f1a",
          durable_id: overrides?.durableId ?? "ws_01J8Z4-payments-repo",
        },
        // released omitted on purpose: create defaults it to false.
      },
      parent: { kind: "Workspace", name: "payments-repo" },
    },
    status: {},
  };
}

async function postClaim(base: string, name: string, body: unknown): Promise<Response> {
  return fetch(`${base}/Claim/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchClaim(base: string, name: string, body: unknown): Promise<Response> {
  return fetch(`${base}/Claim/${name}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The release PATCH body: the full claim envelope (PATCH carries the whole
 * document — the only permitted change vs the stored claim is
 * spec.claim.released: true). Builds from validClaimBody so the release
 * re-asserts the parent's claimedOn identity exactly.
 */
function releaseBody(
  name: string,
  overrides?: { fingerprint?: string; durableId?: string; route?: unknown },
): unknown {
  const body = validClaimBody(name, overrides) as { spec: { claim: Record<string, unknown> } };
  body.spec.claim.released = true;
  return body;
}

describe("POST /Claim/<name> — claim create (core §9, workspace §8)", () => {
  it("(a) valid claim against payments-repo → 201; doc fields applied (released defaults false, URL name wins the envelope); claim visible in discovery + resolution immediately", async () => {
    const { base, store } = await boot();
    const res = await postClaim(base, "claim-payments-feat-x", validClaimBody("claim-payments-feat-x"));
    expect(res.status).toBe(201);
    const doc = (await res.json()) as {
      kind: string;
      metadata: { name: string };
      spec: { claim: Record<string, unknown>; parent: { kind: string; name: string } };
    };
    expect(doc.kind).toBe("Claim");
    expect(doc.metadata.name).toBe("claim-payments-feat-x");
    expect(doc.spec.claim.released).toBe(false);
    expect(doc.spec.claim.storageBacked).toBe(false);
    expect(doc.spec.claim.id).toBe("cl_test-claim-payments-feat-x");
    expect(doc.spec.claim.principal).toBe("pi/0.99.1@workstation");
    expect(doc.spec.parent).toEqual({ kind: "Workspace", name: "payments-repo" });

    // The overlay merges over the watched set at read time: the claim is in
    // the current snapshot, in discovery, and resolvable, without any reload.
    expect(store.get("Claim", "claim-payments-feat-x")?.name).toBe("claim-payments-feat-x");

    const discovery = await (await fetch(base)).json() as Array<Record<string, unknown>>;
    const row = discovery.find((r) => r["kind"] === "Claim" && r["name"] === "claim-payments-feat-x");
    expect(row).toMatchObject({
      kind: "Claim",
      name: "claim-payments-feat-x",
      durable_id: "cl_test-claim-payments-feat-x",
      parent: { kind: "Workspace", name: "payments-repo" },
    });

    const resolved = await fetch(`${base}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "Claim",
        name: "claim-payments-feat-x",
        consumer: { agentLocation: "workstation", agentKind: "pi", principal: "user:example" },
      }),
    });
    // Claims don't route (routes: []): the claim is present but NoMatch.
    expect(await resolved.json()).toEqual({ result: "NoMatch" });
  });

  it("(b) missing parent → 409 naming the missing parent; overlay untouched (Review Focus #1)", async () => {
    const { base, store } = await boot();
    const body = validClaimBody("claim-orphan") as Record<string, unknown>;
    (body["spec"] as Record<string, unknown>)["parent"] = { kind: "Workspace", name: "no-such-workspace" };
    const res = await postClaim(base, "claim-orphan", body);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("no-such-workspace");
    expect(json.error).toContain("Workspace");
    expect(store.get("Claim", "claim-orphan")).toBeUndefined();
    expect(store.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(0);
  });

  it("(c) duplicate Claim name → 409 (claim collision rule); the first claim is untouched", async () => {
    const { base, store } = await boot();
    const first = await postClaim(base, "claim-dup", validClaimBody("claim-dup"));
    expect(first.status).toBe(201);

    const secondBody = validClaimBody("claim-dup");
    // Different claim id — the collision is on the name, nothing else.
    const spec = (secondBody as Record<string, unknown>)["spec"] as Record<string, unknown>;
    (spec["claim"] as Record<string, unknown>)["id"] = "cl_test-other";
    const second = await postClaim(base, "claim-dup", secondBody);
    expect(second.status).toBe(409);
    const json = (await second.json()) as { error: string };
    expect(json.error).toContain("claim-dup");

    // The overlay still holds exactly the first claim.
    const stored = store.get("Claim", "claim-dup");
    expect(stored?.kindSpec["id"]).toBe("cl_test-claim-dup");
    expect(store.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(1);
  });

  it("(d) claimedOn.fingerprint mismatch → 4xx naming the fingerprint (claims occupy the storage they claim against, §8.4)", async () => {
    const { base, store } = await boot();
    const res = await postClaim(base, "claim-bad-fp", validClaimBody("claim-bad-fp", { fingerprint: "vol-WRONG" }));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("fingerprint");
    expect(json.error).toContain("vol-WRONG");
    expect(json.error).toContain("vol-2c4f1a");
    expect(store.get("Claim", "claim-bad-fp")).toBeUndefined();
  });

  it("(e) claimedOn.durable_id mismatch → 4xx naming the durable id", async () => {
    const { base, store } = await boot();
    const res = await postClaim(base, "claim-bad-id", validClaimBody("claim-bad-id", { durableId: "ws_WRONG" }));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("durable_id");
    expect(json.error).toContain("ws_WRONG");
    expect(json.error).toContain("ws_01J8Z4-payments-repo");
    expect(store.get("Claim", "claim-bad-id")).toBeUndefined();
  });

  it("(f) non-object spec.claim.route → 400", async () => {
    const { base, store } = await boot();
    const res = await postClaim(base, "claim-bad-route", validClaimBody("claim-bad-route", { route: "local" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("route");
    expect(store.get("Claim", "claim-bad-route")).toBeUndefined();
  });
});

describe("validateClaimCreate — unit-level pins", () => {
  it("body/URL name mismatch → 400", () => {
    const store = startStore(tempDocuments());
    const checked = validateClaimCreate(validClaimBody("claim-a"), "claim-b", store);
    expect(checked).toMatchObject({ ok: false, status: 400 });
    if (!checked.ok) expect(checked.error).toContain("claim-b");
  });

  it("missing spec.claim.id → 400 (Claim durable id is required, §4.3)", () => {
    const store = startStore(tempDocuments());
    const body = validClaimBody("claim-noid") as Record<string, unknown>;
    const claim = ((body["spec"] as Record<string, unknown>)["claim"] as Record<string, unknown>);
    delete claim["id"];
    const checked = validateClaimCreate(body, "claim-noid", store);
    expect(checked).toMatchObject({ ok: false, status: 400 });
    if (!checked.ok) expect(checked.error).toContain("spec.claim.id");
  });
});

describe("appendOverlay — the write-time validation seam", () => {
  it("a document that would violate §8.3 in the merged set is refused and nothing is appended", () => {
    const store = startStore(tempDocuments());
    // A Claim whose durable id duplicates an existing document's — the merged
    // set (watched ∪ overlay ∪ new) trips rejectCheck's duplicate-id rule.
    const body = validClaimBody("claim-poison") as Record<string, unknown>;
    (((body["spec"] as Record<string, unknown>)["claim"]) as Record<string, unknown>)["id"] =
      "ws_01J8Z4-payments-repo";
    const checked = validateClaimCreate(body, "claim-poison", store);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const result = store.appendOverlay(checked.doc);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate durable id");
    expect(store.get("Claim", "claim-poison")).toBeUndefined();
    expect(store.health()).toEqual({ documentSet: "current", warnings: [] });
  });

  it("two different claims against one parent both land (claims share claimedOn freely; advisory in v1alpha1)", () => {
    const store = startStore(tempDocuments());
    for (const name of ["claim-one", "claim-two"]) {
      const checked = validateClaimCreate(validClaimBody(name), name, store);
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(store.appendOverlay(checked.doc).ok).toBe(true);
    }
    expect(store.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(2);
  });
});

describe("PATCH /Claim/<name> — claim release (workspace §8: release is the only permitted mutation)", () => {
  it("(a) release an existing claim → 200, released true, overlay records the released version latest-per-name", async () => {
    const { base, store } = await boot();
    const created = await postClaim(base, "claim-rel", validClaimBody("claim-rel"));
    expect(created.status).toBe(201);

    const res = await patchClaim(base, "claim-rel", releaseBody("claim-rel"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { metadata: { name: string }; spec: { claim: Record<string, unknown> } };
    expect(doc.metadata.name).toBe("claim-rel");
    expect(doc.spec.claim.released).toBe(true);
    // Untouched fields ride through verbatim.
    expect(doc.spec.claim.id).toBe("cl_test-claim-rel");

    // The overlay now holds the released version — readers see latest-per-name.
    expect(store.get("Claim", "claim-rel")?.kindSpec["released"]).toBe(true);
    // Discovery reflects the release immediately (no reload).
    expect(
      store.current().documents.find((d) => d.kind === "Claim" && d.name === "claim-rel")?.kindSpec["released"],
    ).toBe(true);
  });

  it("(b) PATCH on a missing claim → 404", async () => {
    const { base, store } = await boot();
    const res = await patchClaim(base, "claim-absent", releaseBody("claim-absent"));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("claim-absent");
    expect(store.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(0);
  });

  it("(c) PATCH changing spec.claim.parameters → 409 naming the field; stored claim untouched", async () => {
    const { base, store } = await boot();
    const created = await postClaim(base, "claim-mut", validClaimBody("claim-mut"));
    expect(created.status).toBe(201);

    const body = releaseBody("claim-mut") as { spec: { claim: Record<string, unknown> } };
    body.spec.claim.parameters = { branch: "main" };
    const res = await patchClaim(base, "claim-mut", body);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("spec.claim.parameters");

    // The stored claim keeps its original parameters and stays unreleased.
    const stored = store.get("Claim", "claim-mut");
    expect(stored?.kindSpec["parameters"]).toEqual({ branch: "feat-x", worktreeName: "feat-x" });
    expect(stored?.kindSpec["released"]).toBe(false);
  });

  it("(d) re-release an already-released claim → 200 idempotent (no-op release)", async () => {
    const { base, store } = await boot();
    await postClaim(base, "claim-idem", validClaimBody("claim-idem"));
    const first = await patchClaim(base, "claim-idem", releaseBody("claim-idem"));
    expect(first.status).toBe(200);

    const second = await patchClaim(base, "claim-idem", releaseBody("claim-idem"));
    expect(second.status).toBe(200);
    expect(store.get("Claim", "claim-idem")?.kindSpec["released"]).toBe(true);
    // Still exactly one claim under the name — the overlay holds latest-per-name.
    expect(store.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(1);
  });

  it("(extra) PATCH attempting to re-claim after release (released: false) → 409 naming spec.claim.released", async () => {
    const { base, store } = await boot();
    await postClaim(base, "claim-unrel", validClaimBody("claim-unrel"));
    await patchClaim(base, "claim-unrel", releaseBody("claim-unrel"));

    // An explicit released: false against the released claim flips the flag
    // true → false: a forbidden re-claim, diff-named at spec.claim.released.
    const body = validClaimBody("claim-unrel") as { spec: { claim: Record<string, unknown> } };
    body.spec.claim.released = false;
    const res = await patchClaim(base, "claim-unrel", body);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("spec.claim.released");
    expect(store.get("Claim", "claim-unrel")?.kindSpec["released"]).toBe(true);
  });

  it("(extra) PATCH with a partial body (no envelope) → 400; store untouched", async () => {
    const { base, store } = await boot();
    await postClaim(base, "claim-partial", validClaimBody("claim-partial"));
    const res = await patchClaim(base, "claim-partial", { spec: { claim: { released: true } } });
    expect(res.status).toBe(400);
    expect(store.get("Claim", "claim-partial")?.kindSpec["released"]).toBe(false);
  });
});

describe("orphan release — T2a-2 ruling (release must remain possible for orphan claims)", () => {
  it("create → delete parent workspace file → reload → release with unchanged parent+claimedOn still succeeds", async () => {
    const dir = tempDocuments(tempBaseline);
    const store = startStore(dir);
    const server = createServer(store);
    openServers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}/twill/v1alpha1`;

    // tempBaseline de-aliases payments-repo: fingerprint vol-payments-01, no parent.
    const created = await postClaim(
      base,
      "claim-orphan-rel",
      validClaimBody("claim-orphan-rel", { fingerprint: "vol-payments-01" }),
    );
    expect(created.status).toBe(201);

    // The parent is deleted after the claim exists — §8.3's orphan case:
    // never a set-level rejection, and the reload stays current.
    rmSync(join(dir, "Workspace", "payments-repo.yaml"));
    store.reload();
    expect(store.get("Workspace", "payments-repo")).toBeUndefined();
    expect(store.health().documentSet).toBe("current");

    // Unchanged spec.parent + spec.claim.claimedOn ⇒ the release path skips
    // the parent-existence and claimedOn-consistency re-checks (they were
    // validated at create; an unreleasable orphan would deadlock the GC path).
    const res = await patchClaim(base, "claim-orphan-rel", releaseBody("claim-orphan-rel", { fingerprint: "vol-payments-01" }));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { spec: { claim: Record<string, unknown> } };
    expect(doc.spec.claim.released).toBe(true);
    expect(store.get("Claim", "claim-orphan-rel")?.kindSpec["released"]).toBe(true);
  });

  it("orphan release with a CHANGED parent or claimedOn re-validates against the live set (409 missing parent)", () => {
    const dir = tempDocuments(tempBaseline);
    const store = startStore(dir);
    const created = validateClaimCreate(
      validClaimBody("claim-orphan-strict", { fingerprint: "vol-payments-01" }),
      "claim-orphan-strict",
      store,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(store.appendOverlay(created.doc).ok).toBe(true);

    rmSync(join(dir, "Workspace", "payments-repo.yaml"));
    store.reload();
    expect(store.get("Workspace", "payments-repo")).toBeUndefined();

    // The skip applies only when parent AND claimedOn are unchanged; a
    // release that moves claimedOn re-runs the create-time checks and hits
    // the missing parent.
    const moved = releaseBody("claim-orphan-strict", { fingerprint: "vol-elsewhere" });
    const checked = validateClaimRelease("claim-orphan-strict", moved, store);
    expect(checked).toMatchObject({ ok: false, status: 409 });
    if (!checked.ok) expect(checked.error).toContain("does not exist");
    expect(store.get("Claim", "claim-orphan-strict")?.kindSpec["released"]).toBe(false);
  });
});

describe("validateClaimRelease — unit-level pins", () => {
  it("changing spec.claim.id → 409 naming it (a non-released mutation on an existing parent)", () => {
    const store = startStore(tempDocuments());
    const created = validateClaimCreate(validClaimBody("claim-unit"), "claim-unit", store);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(store.appendOverlay(created.doc).ok).toBe(true);

    const body = releaseBody("claim-unit") as { spec: { claim: Record<string, unknown> } };
    body.spec.claim.id = "cl_test-swapped";
    const checked = validateClaimRelease("claim-unit", body, store);
    expect(checked).toMatchObject({ ok: false, status: 409 });
    if (!checked.ok) expect(checked.error).toContain("spec.claim.id");
  });

  it("re-pointing the parent at a nonexistent workspace → 409 (parent existence still enforced, envelope-level)", () => {
    const store = startStore(tempDocuments());
    const created = validateClaimCreate(validClaimBody("claim-unit2"), "claim-unit2", store);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(store.appendOverlay(created.doc).ok).toBe(true);

    const body = releaseBody("claim-unit2") as { spec: { parent: { kind: string; name: string } } };
    body.spec.parent = { kind: "Workspace", name: "no-such-workspace" };
    const checked = validateClaimRelease("claim-unit2", body, store);
    expect(checked).toMatchObject({ ok: false, status: 409 });
    if (!checked.ok) expect(checked.error).toContain("no-such-workspace");
  });
});

describe("claim surface — GET paths still 501 in Task 2", () => {
  it("GET /Claim/<name> and GET /claims keep the T1 501", async () => {
    const { base } = await boot();
    const getOne = await fetch(`${base}/Claim/x`);
    expect(getOne.status).toBe(501);
    expect(await getOne.json()).toEqual({ error: "claims unimplemented in T1 milestone", milestone: "T2" });

    const getClaims = await fetch(`${base}/claims?parent=Workspace/payments-repo`);
    expect(getClaims.status).toBe(501);
  });
});
