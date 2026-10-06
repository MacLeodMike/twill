// Registry store tests (Task 5) — watched directory, reload semantics,
// last-good snapshots, snapshot consistency (Review Focus #4).
//
// Each test copies the fixtures into a fresh temp dir (never watches the
// fixture dir itself) and mutates the copy. Watcher-driven tests poll with
// a deadline instead of a fixed sleep; deterministic cases call reload()
// directly so they never rely on watch timing.

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryStore, start, type Snapshot } from "./store.js";
import { resolve as resolveRoute, type ResolveStore } from "./resolver.js";
import type { Consumer } from "./matching.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openStores: RegistryStore[] = [];
const tempDirs: string[] = [];

/** Fresh temp dir with the fixtures copied in (plus an optional mutation). */
function tempDocuments(mutate?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-store-"));
  cpSync(fixtures, dir, { recursive: true });
  mutate?.(dir);
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

/**
 * The fixture pair (payments-repo + workstation-repos) shares fingerprint
 * vol-2c4f1a with no lineage — it is an aliasing pair. A *good* baseline
 * breaks the collision by giving payments-repo a distinct fingerprint.
 */
function goodBaseline(dir: string): void {
  const p = join(dir, "Workspace", "payments-repo.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("vol-2c4f1a", "vol-payments-01"));
}

/** An unrelated Workspace root with the given (colliding) fingerprint. */
function writeWorkspace(dir: string, name: string, storageId: string, fingerprint: string): void {
  mkdirSync(join(dir, "Workspace"), { recursive: true });
  writeFileSync(
    join(dir, "Workspace", `${name}.yaml`),
    `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: ${name} }
spec:
  owner: user:test
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos/${name}
  workspace:
    storageBacked: true
    accessMode: RWO
    storage: { id: ${storageId}, fingerprint: ${fingerprint} }
status: {}
`,
  );
}

/** Poll until `cond` is true (deadline, not fixed sleep). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met within deadline");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const consumer: Consumer = { agentLocation: "workstation", agentKind: "pi", principal: "user:test" };

/** A ResolveStore view over a held snapshot (Review Focus #4). */
function snapshotStore(snap: Snapshot, statusCache: ResolveStore["statusCache"]): ResolveStore {
  return { get: (kind, name) => snap.byName.get(`${kind}/${name}`), statusCache };
}

describe("RegistryStore", () => {
  it("initial load of a good set: current health, 2 documents, generation 1", () => {
    const dir = tempDocuments(goodBaseline);
    const store = startStore(dir);

    expect(store.health()).toEqual({ documentSet: "current", warnings: [] });

    const snap = store.current();
    expect(snap.documents).toHaveLength(2);
    expect(snap.generation).toBe(1);
    expect(snap.byName.get("Workspace/payments-repo")?.resolvable).toBe(true);
    expect(snap.byName.get("Workspace/workstation-repos")?.resolvable).toBe(true);

    // ResolveStore wiring pin (Task 6): get() answers from the snapshot.
    expect(store.get("Workspace", "workstation-repos")?.name).toBe("workstation-repos");
    expect(store.get("Workspace", "nope")).toBeUndefined();
    expect(store.statusCache).toBeInstanceOf(Map);
  });

  it("watcher-driven aliasing append: rejected reload keeps serving the last-good snapshot", async () => {
    const dir = tempDocuments(goodBaseline);
    const store = startStore(dir);

    // Append an unrelated root colliding on workstation-repos' fingerprint.
    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-2c4f1a");
    await until(() => store.health().documentSet === "stale");

    const health = store.health();
    expect(health.rejectedAt).toBeTruthy();
    expect(health.reason).toContain("fingerprint collision");
    expect(health.warnings).toEqual([]);

    // Last-good snapshot still served, unchanged.
    const snap = store.current();
    expect(snap.documents).toHaveLength(2);
    expect(snap.generation).toBe(1);
    expect(store.get("Workspace", "cluster-repos")).toBeUndefined();
  });

  it("fixing the colliding file returns the store to current with an incremented generation", async () => {
    const dir = tempDocuments(goodBaseline);
    const store = startStore(dir);

    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-2c4f1a");
    await until(() => store.health().documentSet === "stale");

    // Fix: give the appended root a distinct fingerprint.
    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-cluster-99");
    await until(() => store.health().documentSet === "current");

    const health = store.health();
    expect(health.rejectedAt).toBeUndefined();
    expect(health.reason).toBeUndefined();

    const snap = store.current();
    expect(snap.documents).toHaveLength(3);
    expect(snap.generation).toBe(2); // one increment per accepted reload
    expect(store.get("Workspace", "cluster-repos")?.name).toBe("cluster-repos");
  });

  it("cold start on a rejected set: empty snapshot, stale health, logged; recovers on reload", () => {
    // The raw fixtures are already an aliasing pair (shared fingerprint, no lineage).
    const dir = tempDocuments();
    const store = startStore(dir);

    const health = store.health();
    expect(health.documentSet).toBe("stale");
    expect(health.rejectedAt).toBeTruthy();
    expect(health.reason).toContain("fingerprint collision");
    expect(health.warnings).toEqual([]);

    const snap = store.current();
    expect(snap.documents).toHaveLength(0);
    expect(snap.byName.size).toBe(0);
    expect(snap.generation).toBe(0);
    expect(store.get("Workspace", "payments-repo")).toBeUndefined();

    // Recovery via a direct reload (watch timing not relied on).
    goodBaseline(dir);
    store.reload();
    expect(store.health().documentSet).toBe("current");
    expect(store.current().documents).toHaveLength(2);
    expect(store.current().generation).toBe(1);
  });

  it("a snapshot held across a bad reload is a stable world (Review Focus #4)", () => {
    const dir = tempDocuments(goodBaseline);
    const store = startStore(dir);

    // Pre-check: the store itself satisfies ResolveStore.
    expect(resolveRoute("Workspace", "payments-repo", consumer, store).result).toBe("Attached");

    const snap = store.current();

    // Force a rejected reload deterministically (no reliance on watch timing).
    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-2c4f1a");
    store.reload();
    expect(store.health().documentSet).toBe("stale");

    // The rejected reload swapped nothing: same snapshot object still served.
    expect(store.current()).toBe(snap);
    expect(snap.documents).toHaveLength(2);
    expect(snap.generation).toBe(1);

    // A resolver holding the old snapshot still resolves the old document.
    expect(resolveRoute("Workspace", "payments-repo", consumer, snapshotStore(snap, store.statusCache)).result)
      .toBe("Attached");
    // And the store (last-good) resolves it too.
    expect(resolveRoute("Workspace", "payments-repo", consumer, store).result).toBe("Attached");

    // After the next accepted reload the store moves on; the held snapshot does not.
    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-cluster-99");
    store.reload();
    expect(store.health().documentSet).toBe("current");
    expect(store.current()).not.toBe(snap);
    expect(store.current().documents).toHaveLength(3);
    expect(snap.documents).toHaveLength(2); // unchanged
  });

  it("close() stops watchers and timers: idempotent, and no reloads fire afterwards", async () => {
    const dir = tempDocuments(goodBaseline);
    const store = startStore(dir);

    store.close();
    store.close(); // idempotent

    // A mutation after close must not trigger a debounced reload.
    writeWorkspace(dir, "cluster-repos", "ws_cluster-repos", "vol-2c4f1a");
    await new Promise((r) => setTimeout(r, 300));
    expect(store.health().documentSet).toBe("current");
    expect(store.current().documents).toHaveLength(2);
  });
});