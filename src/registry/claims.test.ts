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

describe("GET /claims?parent=<kind>/<name> — the provider claims read-path (Task 5)", () => {
  it("(a) claims against payments-repo → 200 with the claim (verbatim envelope); an unrelated parent's claim is not listed", async () => {
    const { base } = await boot();
    const created = await postClaim(base, "claim-rp-a", validClaimBody("claim-rp-a"));
    expect(created.status).toBe(201);

    // A second claim against workstation-repos must not leak into the
    // payments-repo answer (claimedOn re-pointed at that parent — storage
    // fingerprint included, §8.4).
    const other = validClaimBody("claim-rp-other") as { spec: { claim: Record<string, unknown>; parent: Record<string, string> } };
    other.spec.claim.claimedOn = { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-workstation-repos" };
    other.spec.parent = { kind: "Workspace", name: "workstation-repos" };
    const second = await postClaim(base, "claim-rp-other", other);
    expect(second.status).toBe(201);

    const res = await fetch(`${base}/claims?parent=${encodeURIComponent("Workspace/payments-repo")}`);
    expect(res.status).toBe(200);
    const claims = (await res.json()) as Array<{
      kind: string;
      metadata: { name: string };
      spec: { parent: { kind: string; name: string }; claim: Record<string, unknown> };
      status: Record<string, unknown>;
    }>;
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    // Verbatim envelope: the served object is the stored raw document.
    expect(claim.kind).toBe("Claim");
    expect(claim.metadata.name).toBe("claim-rp-a");
    expect(claim.spec.parent).toEqual({ kind: "Workspace", name: "payments-repo" });
    expect(claim.spec.claim.id).toBe("cl_test-claim-rp-a");
    expect(claim.spec.claim.released).toBe(false);
    // Non-orphan claims carry no inert stamp.
    expect(claim.status["inert"]).toBeUndefined();
  });

  it("(b) no parent param → 400 naming it; parent present but empty → 400", async () => {
    const { base } = await boot();
    const missing = await fetch(`${base}/claims`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("parent");

    const empty = await fetch(`${base}/claims?parent=`);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain("parent");
  });

  it("(c) parent that never existed → 200 [] (providers poll for parents that may not be registered yet)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/claims?parent=${encodeURIComponent("Workspace/no-such-workspace")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("(d) parent file deleted → reload → claim still listed (marked inert) + health carries the orphan entry; claimedBy still derives (Task 4 un-regressed)", async () => {
    const dir = tempDocuments(tempBaseline);
    const store = startStore(dir);
    const server = createServer(store);
    openServers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}/twill/v1alpha1`;

    // tempBaseline de-aliases payments-repo: fingerprint vol-payments-01, no
    // parent. A sibling sharing the claimed storage fingerprint lets the
    // claimedBy regression guard observe the claim after the parent is gone.
    writeFileSync(
      join(dir, "Workspace", "payments-sibling.yaml"),
      `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: payments-sibling }
spec:
  owner: user:test
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos/payments-sibling
  workspace:
    storageBacked: true
    accessMode: RWO
    storage: { id: ws-payments-sibling, fingerprint: vol-payments-01 }
status: {}
`,
    );
    store.reload();

    const created = await postClaim(
      base,
      "claim-rp-orphan",
      validClaimBody("claim-rp-orphan", { fingerprint: "vol-payments-01" }),
    );
    expect(created.status).toBe(201);
    expect(store.health().warnings).toEqual([]);

    // The parent is deleted after the claim exists — §8.3's orphan case:
    // inert + health warning, never a set-level rejection.
    rmSync(join(dir, "Workspace", "payments-repo.yaml"));
    store.reload();
    expect(store.get("Workspace", "payments-repo")).toBeUndefined();
    expect(store.health().documentSet).toBe("current");

    // The claim is still served against the parent's name (orphan claims
    // are listed), marked inert in its serialized form.
    const res = await fetch(`${base}/claims?parent=${encodeURIComponent("Workspace/payments-repo")}`);
    expect(res.status).toBe(200);
    const claims = (await res.json()) as Array<{ metadata: { name: string }; status: Record<string, unknown> }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.metadata.name).toBe("claim-rp-orphan");
    expect(claims[0]!.status["inert"]).toBe(true);

    // Store-level marking: the claim document itself is inert with a reason
    // naming the orphan parent.
    const stored = store.get("Claim", "claim-rp-orphan");
    expect(stored?.resolvable).toBe(false);
    expect(stored?.inertReasons.some((r) => r.includes("Workspace/payments-repo"))).toBe(true);

    // Health warnings carry the §8.3 orphan entry.
    expect(store.health().warnings).toContainEqual({
      type: "orphan-claim",
      claim: "claim-rp-orphan",
      parent: "Workspace/payments-repo",
    });
    const health = await (await fetch(`${base}/health`)).json() as { documentSet: string; warnings: unknown[] };
    expect(health.documentSet).toBe("current");
    expect(health.warnings).toContainEqual({
      type: "orphan-claim",
      claim: "claim-rp-orphan",
      parent: "Workspace/payments-repo",
    });

    // Task 4 regression guard: the orphan claim still derives claimedBy —
    // claimedOn is self-contained, so a sibling still sharing the claimed
    // storage fingerprint reports the claim.
    const statusRes = await fetch(`${base}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "Workspace",
        name: "payments-sibling",
        consumer: { agentLocation: "workstation", agentKind: "pi", principal: "user:example" },
      }),
    });
    const resolved = (await statusRes.json()) as {
      descriptor?: { status: { claimedBy: Array<Record<string, unknown>> } };
    };
    expect(resolved.descriptor?.status.claimedBy).toContainEqual({
      name: "claim-rp-orphan",
      owner: "user:example",
      principal: "pi/0.99.1@workstation",
      claimedOn: { fingerprint: "vol-payments-01", durable_id: "ws_01J8Z4-payments-repo" },
    });
  });

  it("(d') orphanhood clears when the parent is re-registered (recomputed on reload, both ways)", async () => {
    const dir = tempDocuments(tempBaseline);
    const store = startStore(dir);

    const checked = validateClaimCreate(
      validClaimBody("claim-rp-restore", { fingerprint: "vol-payments-01" }),
      "claim-rp-restore",
      store,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(store.appendOverlay(checked.doc)).toEqual({ ok: true });

    rmSync(join(dir, "Workspace", "payments-repo.yaml"));
    store.reload();
    expect(store.health().warnings).toContainEqual({
      type: "orphan-claim",
      claim: "claim-rp-restore",
      parent: "Workspace/payments-repo",
    });
    expect(store.get("Claim", "claim-rp-restore")?.resolvable).toBe(false);

    // The parent comes back (Flux re-sync / operator restore): the next
    // accepted load recomputes — the claim is resolvable again and the
    // warning is gone.
    cpSync(join(fixtures, "Workspace", "payments-repo.yaml"), join(dir, "Workspace", "payments-repo.yaml"));
    store.reload();
    expect(store.health()).toEqual({ documentSet: "current", warnings: [] });
    expect(store.get("Claim", "claim-rp-restore")?.resolvable).toBe(true);
  });

  it("(e) includeReleased=false (default) filters released claims; includeReleased=true lists them", async () => {
    const { base, store } = await boot();
    const created = await postClaim(base, "claim-rp-rel", validClaimBody("claim-rp-rel"));
    expect(created.status).toBe(201);
    const released = await patchClaim(base, "claim-rp-rel", releaseBody("claim-rp-rel"));
    expect(released.status).toBe(200);
    expect(store.get("Claim", "claim-rp-rel")?.kindSpec["released"]).toBe(true);

    // Default: un-released only — the released claim is filtered out.
    const def = await fetch(`${base}/claims?parent=${encodeURIComponent("Workspace/payments-repo")}`);
    expect(def.status).toBe(200);
    expect(await def.json()).toEqual([]);

    // Opt in: the released claim is listed, envelope verbatim.
    const all = await fetch(
      `${base}/claims?parent=${encodeURIComponent("Workspace/payments-repo")}&includeReleased=true`,
    );
    expect(all.status).toBe(200);
    const claims = (await all.json()) as Array<{ metadata: { name: string }; spec: { claim: Record<string, unknown> } }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.metadata.name).toBe("claim-rp-rel");
    expect(claims[0]!.spec.claim.released).toBe(true);

    // Any value other than the literal "true" keeps the default filter.
    const sloppy = await fetch(
      `${base}/claims?parent=${encodeURIComponent("Workspace/payments-repo")}&includeReleased=1`,
    );
    expect(sloppy.status).toBe(200);
    expect(await sloppy.json()).toEqual([]);
  });
});

describe("claim surface — the single-claim GET stays 501 (Task 5 removed the /claims 501)", () => {
  it("GET /Claim/<name> keeps the T1 501; GET /claims answers 200/400 per its own contract", async () => {
    const { base } = await boot();
    const getOne = await fetch(`${base}/Claim/x`);
    expect(getOne.status).toBe(501);
    expect(await getOne.json()).toEqual({ error: "claims unimplemented in T1 milestone", milestone: "T2" });

    const getClaims = await fetch(`${base}/claims?parent=Workspace/payments-repo`);
    expect(getClaims.status).toBe(200);
    expect(await getClaims.json()).toEqual([]);
  });
});
