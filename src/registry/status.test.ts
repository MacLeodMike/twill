// claimedBy derivation tests (T2a Task 4) — core §8.4 keying: a claim's
// occupancy identity is claimedOn {fingerprint, durable_id}; claimedBy
// derives from un-released Claim documents keyed on fingerprint for
// storage-backed kinds (Workspace) and on durable_id for the rest.
//
// Stores boot on a temp copy of fixtures/documents (never the fixture dir
// itself). NOTE (ledger): overlay appends write `.twill-overlay.jsonl`
// inside the watched dir, which triggers a content-identical self-watch
// reload — tests never assert exact generation numbers across appends.

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type RegistryStore } from "./store.js";
import { validateClaimCreate, validateClaimRelease } from "./claims.js";
import { deriveClaimedBy, statusFor, type ClaimedRef } from "./status.js";
import { resolve as resolveDoc, type Consumer } from "./resolver.js";
import { durableIdOf, type FabricDocument } from "./document.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openStores: RegistryStore[] = [];
const tempDirs: string[] = [];

function tempDocuments(): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-status-"));
  cpSync(fixtures, dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function startStore(dir: string): RegistryStore {
  const store = start(dir);
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The fixture trio all share fingerprint vol-2c4f1a; durable ids differ. */
const FP = "vol-2c4f1a";
const ID_PARENT = "ws_01J8Z4-payments-repo";
const ID_CHILD = "ws_01J8Z4-payments-repo-feat-x";

/**
 * Append a valid claim against a fixture Workspace. `parentName` decides
 * the claimedOn.durable_id (validator pins it to the parent's durable id);
 * all three fixture workspaces share fingerprint vol-2c4f1a.
 */
function addClaim(
  store: RegistryStore,
  name: string,
  parentName: string,
  opts?: { principal?: string; owner?: string },
): FabricDocument {
  const parent = store.get("Workspace", parentName);
  expect(parent).toBeDefined();
  const body = {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Claim",
    metadata: { name },
    spec: {
      owner: opts?.owner ?? "user:example",
      routes: [],
      claim: {
        storageBacked: false,
        id: `cl_${name}`,
        principal: opts?.principal ?? `pi/test@${name}`,
        route: { match: { agentLocation: "workstation" }, type: "local", path: `~/repos/${parentName}` },
        parameters: {},
        claimedOn: { fingerprint: FP, durable_id: durableIdOf(parent!) },
      },
      parent: { kind: "Workspace", name: parentName },
    },
    status: {},
  };
  const checked = validateClaimCreate(body, name, store);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error("claim validation failed in test setup");
  const appended = store.appendOverlay(checked.doc);
  expect(appended.ok).toBe(true);
  return checked.doc;
}

/** Release a claim through the Task 2 path (latest-per-name overlay line). */
function releaseClaim(store: RegistryStore, name: string): void {
  const stored = store.get("Claim", name);
  expect(stored).toBeDefined();
  const raw = JSON.parse(JSON.stringify(stored!.raw)) as { spec: { claim: Record<string, unknown> } };
  raw.spec.claim.released = true;
  const checked = validateClaimRelease(name, raw, store);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error("release validation failed in test setup");
  if (store.get("Claim", name) !== checked.doc) {
    expect(store.appendOverlay(checked.doc).ok).toBe(true);
  }
}

/** Store-front helper: the merged claims view the derivation reads. */
function claimsOf(store: RegistryStore): FabricDocument[] {
  return store.claims();
}

const claimedNames = (refs: ClaimedRef[]): string[] => refs.map((r) => r.name);

describe("deriveClaimedBy (core §8.4)", () => {
  it("(a) single claim against payments-repo → payments-repo's claimedBy shows it; fingerprint-sharing relatives still show it (fingerprint keying), unrelated docs do not", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    const child = store.get("Workspace", "payments-repo-feat-x")!;
    addClaim(store, "claim-a", "payments-repo", { principal: "pi/0.99.1@workstation" });
    const claims = claimsOf(store);

    const refs = deriveClaimedBy(parent, claims);
    expect(claimedNames(refs)).toEqual(["claim-a"]);
    expect(refs[0]).toEqual({
      name: "claim-a",
      owner: "user:example",
      principal: "pi/0.99.1@workstation",
      claimedOn: { fingerprint: FP, durable_id: ID_PARENT },
    });

    // §8.4: storage-backed docs key on fingerprint — the child shares
    // vol-2c4f1a, so the parent's claim is visible through the child too.
    expect(claimedNames(deriveClaimedBy(child, claims))).toEqual(["claim-a"]);
  });

  it("(b) cross-view visibility (Review Focus #3): claims against parent payments-repo AND child payments-repo-feat-x (both vol-2c4f1a) → BOTH documents' claimedBy list BOTH claims", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    const child = store.get("Workspace", "payments-repo-feat-x")!;
    const root = store.get("Workspace", "workstation-repos")!;

    addClaim(store, "claim-on-parent", "payments-repo", { principal: "pi/session-1@workstation" });
    addClaim(store, "claim-on-child", "payments-repo-feat-x", { principal: "pi/session-2@workstation" });
    const claims = claimsOf(store);

    // The RWO-advisory case §8.4 exists for: whichever view a consumer
    // resolves through, it sees every claim occupying the storage.
    expect(claimedNames(deriveClaimedBy(parent, claims))).toEqual(["claim-on-parent", "claim-on-child"]);
    expect(claimedNames(deriveClaimedBy(child, claims))).toEqual(["claim-on-parent", "claim-on-child"]);
    expect(claimedNames(deriveClaimedBy(root, claims))).toEqual(["claim-on-parent", "claim-on-child"]);

    // Each ref carries its own claim's claimedOn verbatim (durable ids
    // differ across the two claims — the keying is on fingerprint only).
    const parentRefs = deriveClaimedBy(parent, claims);
    expect(parentRefs.find((r) => r.name === "claim-on-parent")?.claimedOn).toEqual({
      fingerprint: FP,
      durable_id: ID_PARENT,
    });
    expect(parentRefs.find((r) => r.name === "claim-on-child")?.claimedOn).toEqual({
      fingerprint: FP,
      durable_id: ID_CHILD,
    });
  });

  it("(c) released claims are excluded the moment released: true lands in the overlay (latest-per-name wins)", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    addClaim(store, "claim-live", "payments-repo");
    addClaim(store, "claim-dead", "payments-repo");
    releaseClaim(store, "claim-dead");

    // The merged set holds latest-per-name: claim-dead's released version.
    expect(store.get("Claim", "claim-dead")?.kindSpec["released"]).toBe(true);
    expect(claimedNames(deriveClaimedBy(parent, claimsOf(store)))).toEqual(["claim-live"]);

    // Releasing the last live claim empties claimedBy.
    releaseClaim(store, "claim-live");
    expect(deriveClaimedBy(parent, claimsOf(store))).toEqual([]);
  });

  it("(d) non-storage-backed kinds key on durable_id: a claim against a Card shows on that Card only, not on a sibling Card", () => {
    const card = (name: string, id: string): FabricDocument => ({
      apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
      kind: "Card",
      name,
      labels: {},
      owner: "user:example",
      routes: [],
      kindSpec: { id, title: name },
      resolvable: true,
      inertReasons: [],
      sourcePath: "test",
      raw: {},
    });
    const cardA = card("card-a", "card_01");
    const cardB = card("card-b", "card_02");

    // In-memory claim against card-a (no fingerprint — §8.4: non-storage-
    // backed kinds leave fingerprint absent).
    const claim: FabricDocument = {
      apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
      kind: "Claim",
      name: "claim-card-a",
      labels: {},
      owner: "user:example",
      routes: [],
      kindSpec: {
        storageBacked: false,
        id: "cl_claim-card-a",
        principal: "pi/test@workstation",
        route: { type: "local" },
        claimedOn: { durable_id: "card_01" },
        released: false,
      },
      parent: { kind: "Card", name: "card-a" },
      resolvable: true,
      inertReasons: [],
      sourcePath: "<overlay>",
      raw: {},
    };

    const refs = deriveClaimedBy(cardA, [claim]);
    expect(claimedNames(refs)).toEqual(["claim-card-a"]);
    expect(refs[0]!.claimedOn).toEqual({ durable_id: "card_01" });
    // Per-object exclusivity: the sibling Card does not see the claim.
    expect(deriveClaimedBy(cardB, [claim])).toEqual([]);
  });

  it("orphan claims (parent deleted) still derive — claimedOn does not depend on the parent existing", () => {
    const dir = tempDocuments();
    const store = startStore(dir);
    // Claim against the ROOT workspace: deleting it leaves no broken lineage
    // chain (payments-repo keeps its own files), so the set stays current
    // and the claim is a §8.3 orphan — parentless but fingerprint-keyed.
    addClaim(store, "claim-orphan", "workstation-repos");

    rmSync(join(dir, "Workspace", "workstation-repos.yaml"), { force: true });
    store.reload();
    expect(store.get("Workspace", "workstation-repos")).toBeUndefined();
    expect(store.health().documentSet).toBe("current");

    // The orphan claim's fingerprint still matches the surviving relatives.
    for (const name of ["payments-repo", "payments-repo-feat-x"]) {
      const doc = store.get("Workspace", name)!;
      expect(claimedNames(deriveClaimedBy(doc, claimsOf(store)))).toEqual(["claim-orphan"]);
    }
  });
});

describe("statusFor — claimedBy derives from claims, never the cache", () => {
  it("never-observed doc with claims: claimedBy derived even when no provider report exists", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    addClaim(store, "claim-noprov", "payments-repo");

    const surface = statusFor(parent, store.statusCache, claimsOf(store));
    expect(surface.source).toBe("cached");
    expect(surface.progress).toBe("no provider report yet");
    expect(claimedNames(surface.claimedBy)).toEqual(["claim-noprov"]);
  });

  it("a cache entry's claimedBy is overridden by derivation (cache can't inject claims — T1 ledger discharge)", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    addClaim(store, "claim-real", "payments-repo");

    // A poisoned/stale cache entry claiming a bogus claim — derivation wins.
    store.statusCache.set("Workspace/payments-repo", {
      ready: true,
      provisionable: false,
      claimedBy: [{ name: "claim-bogus", owner: "x", principal: "x", claimedOn: { durable_id: "injected" } }],
      progress: "mounted",
      asOf: "2026-10-06T00:00:00Z",
      source: "live",
    });
    const surface = statusFor(parent, store.statusCache, claimsOf(store));
    expect(claimedNames(surface.claimedBy)).toEqual(["claim-real"]);
    expect(surface.ready).toBe(true); // report fields still forward
  });

  it("statusReport-cached surface then claim append: next statusFor reflects the claim (derivation is at read time)", () => {
    const store = startStore(tempDocuments());
    const parent = store.get("Workspace", "payments-repo")!;
    expect(statusFor(parent, store.statusCache, claimsOf(store)).claimedBy).toEqual([]);
    addClaim(store, "claim-late", "payments-repo");
    expect(claimedNames(statusFor(parent, store.statusCache, claimsOf(store)).claimedBy)).toEqual(["claim-late"]);
  });
});

describe("(e) resolve integration — descriptor status.claimedBy", () => {
  const consumer: Consumer = { agentLocation: "workstation", agentKind: "pi", principal: "user:example" };

  it("resolving either cross-view workspace shows BOTH claims in the descriptor status", () => {
    const store = startStore(tempDocuments());
    addClaim(store, "claim-on-parent", "payments-repo", { principal: "pi/session-1@workstation" });
    addClaim(store, "claim-on-child", "payments-repo-feat-x", { principal: "pi/session-2@workstation" });

    for (const name of ["payments-repo", "payments-repo-feat-x"]) {
      const result = resolveDoc("Workspace", name, consumer, store);
      expect(result.result).toBe("Attached");
      if (result.result !== "Attached") continue;
      expect(claimedNames(result.descriptor.status.claimedBy)).toEqual(["claim-on-parent", "claim-on-child"]);
    }
  });

  it("after release the descriptor no longer lists the claim (no reload needed)", () => {
    const store = startStore(tempDocuments());
    addClaim(store, "claim-rel", "payments-repo");
    releaseClaim(store, "claim-rel");

    const result = resolveDoc("Workspace", "payments-repo", consumer, store);
    expect(result.result).toBe("Attached");
    if (result.result === "Attached") {
      expect(result.descriptor.status.claimedBy).toEqual([]);
    }
  });
});
