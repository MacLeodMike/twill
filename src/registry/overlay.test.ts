// Overlay persistence tests (T2a Task 3) — the JSONL overlay file at
// <documentsDir>/.twill-overlay.jsonl: restart durability (Review Focus
// #4), shadowing warnings (workspace §8), corrupt-line tolerance, and
// release-survives-restart.
//
// Stores boot on a temp copy of fixtures/documents; the overlay file is
// the default path beside the documents dir (the production layout), so
// these tests exercise the real wiring. Claims are constructed with the
// same validClaimBody/releaseBody helpers as claims.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { start, type RegistryStore } from "./store.js";
import { createServer } from "./server.js";
import { validateClaimCreate, validateClaimRelease } from "./claims.js";
import { durableIdOf } from "./document.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openStores: RegistryStore[] = [];
const openServers: Server[] = [];
const tempDirs: string[] = [];

/** Fresh temp dir with the fixtures copied in. */
function tempDocuments(): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-overlay-"));
  cpSync(fixtures, dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function startStore(dir: string, overlayPath?: string): RegistryStore {
  const store = start(dir, overlayPath);
  openStores.push(store);
  return store;
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
 * `ws_01J8Z4-payments-repo`, fingerprint `vol-2c4f1a`) — same shape as
 * claims.test.ts's helper.
 */
function validClaimBody(name: string): unknown {
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

/** The release PATCH body: the full claim envelope with only released flipped. */
function releaseBody(name: string): unknown {
  const body = validClaimBody(name) as { spec: { claim: Record<string, unknown> } };
  body.spec.claim.released = true;
  return body;
}

/** Create + append a claim to `store`, failing the test on any rejection. */
function appendClaim(store: RegistryStore, name: string): void {
  const checked = validateClaimCreate(validClaimBody(name), name, store);
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(store.appendOverlay(checked.doc)).toEqual({ ok: true });
}

const OVERLAY_FILE = ".twill-overlay.jsonl";

/** Free a store from the afterEach close list (when a test replaces it mid-run). */
function untrack(store: RegistryStore): void {
  const idx = openStores.indexOf(store);
  if (idx !== -1) openStores.splice(idx, 1);
}

/** Boot `store` on an ephemeral port; tracked for afterEach shutdown. */
async function serve(store: RegistryStore): Promise<string> {
  const server = createServer(store);
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/twill/v1alpha1`;
}

describe("overlay persistence — JSONL at <documentsDir>/.twill-overlay.jsonl", () => {
  it("(a) restart durability: claim → close → reopen → claim present, in discovery, claimedOn intact (Review Focus #4)", async () => {
    const dir = tempDocuments();
    const first = startStore(dir);
    appendClaim(first, "claim-restart");
    expect(first.get("Claim", "claim-restart")).toBeDefined();
    first.close();

    const second = startStore(dir);
    const claim = second.get("Claim", "claim-restart");
    expect(claim).toBeDefined();
    expect(claim?.sourcePath).toBe("<overlay>");
    // The derivation inputs (Task 4's claimedBy) survive the restart intact.
    expect(durableIdOf(claim!)).toBe("cl_test-claim-restart");
    expect(claim?.kindSpec["claimedOn"]).toEqual({
      fingerprint: "vol-2c4f1a",
      durable_id: "ws_01J8Z4-payments-repo",
    });
    expect(claim?.parent).toEqual({ kind: "Workspace", name: "payments-repo" });
    expect(second.health()).toEqual({ documentSet: "current", warnings: [] });

    // Discovery through the real HTTP surface lists the restored claim.
    const server = createServer(second);
    openServers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const discovery = (await (
      await fetch(`http://127.0.0.1:${port}/twill/v1alpha1`)
    ).json()) as Array<Record<string, unknown>>;
    const row = discovery.find((r) => r["kind"] === "Claim" && r["name"] === "claim-restart");
    expect(row).toMatchObject({
      kind: "Claim",
      name: "claim-restart",
      durable_id: "cl_test-claim-restart",
      parent: { kind: "Workspace", name: "payments-repo" },
    });
  });

  it("(b) overlay shadows a watched document of the same name: overlay version served, warning in health (workspace §8)", () => {
    const dir = tempDocuments();
    const store = startStore(dir);
    appendClaim(store, "claim-shadowed");

    // An operator drops a watched Claim with the same name into the source.
    mkdirSync(join(dir, "Claim"), { recursive: true });
    writeFileSync(
      join(dir, "Claim", "claim-shadowed.yaml"),
      `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Claim
metadata: { name: claim-shadowed }
spec:
  owner: user:watched
  routes: []
  claim:
    storageBacked: false
    id: cl_watched-shadowed
    principal: watched
    route: { type: local, path: ~/nowhere }
    claimedOn: { fingerprint: vol-2c4f1a, durable_id: ws_01J8Z4-payments-repo }
  parent: { kind: Workspace, name: payments-repo }
status: {}
`,
    );
    store.reload();

    // The overlay wins: the served document is the overlay's, not the watched one.
    const served = store.get("Claim", "claim-shadowed");
    expect(served?.sourcePath).toBe("<overlay>");
    expect(served?.kindSpec["id"]).toBe("cl_test-claim-shadowed");
    expect(served?.resolvable).toBe(true); // watched Claims load inert; the overlay's does not

    expect(store.health().documentSet).toBe("current");
    expect(store.health().warnings).toContainEqual({ type: "overlay-shadow", name: "Claim/claim-shadowed" });

    // Warnings are recomputed per accepted load: remove the watched shadow
    // and the warning clears (the overlay claim stays).
    rmSync(join(dir, "Claim", "claim-shadowed.yaml"));
    store.reload();
    expect(store.get("Claim", "claim-shadowed")?.kindSpec["id"]).toBe("cl_test-claim-shadowed");
    expect(store.health().warnings).toEqual([]);
  });

  it("(c) corrupt overlay line mid-file (partial write): skipped with a warning, the rest still loads — never a crash", () => {
    const dir = tempDocuments();
    const first = startStore(dir);
    appendClaim(first, "claim-good-1");
    appendClaim(first, "claim-good-2");
    first.close();

    // Corrupt the middle line, keeping one valid line on each side.
    const overlayPath = join(dir, OVERLAY_FILE);
    const lines = readFileSync(overlayPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    writeFileSync(overlayPath, [lines[0], '{"kind":"Claim","metadata":{"name": "partial-wri', lines[1], ""].join("\n"));

    const second = startStore(dir);
    expect(second.get("Claim", "claim-good-1")?.kindSpec["id"]).toBe("cl_test-claim-good-1");
    expect(second.get("Claim", "claim-good-2")?.kindSpec["id"]).toBe("cl_test-claim-good-2");
    expect(second.health().documentSet).toBe("current");
    expect(second.health().warnings).toContainEqual({ type: "overlay-corrupt-line", line: 2 });
  });

  it("(d) release survives restart: the released version is the latest line, and the reopened store serves released: true", () => {
    const dir = tempDocuments();
    const first = startStore(dir);
    appendClaim(first, "claim-rel-rst");

    const released = validateClaimRelease("claim-rel-rst", releaseBody("claim-rel-rst"), first);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(first.appendOverlay(released.doc)).toEqual({ ok: true });
    expect(first.get("Claim", "claim-rel-rst")?.kindSpec["released"]).toBe(true);

    // The file records both versions; load() reduces latest-per-name.
    const lines = readFileSync(join(dir, OVERLAY_FILE), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    first.close();

    const second = startStore(dir);
    const claim = second.get("Claim", "claim-rel-rst");
    expect(claim?.kindSpec["released"]).toBe(true);
    expect(claim?.kindSpec["id"]).toBe("cl_test-claim-rel-rst");
    // Still exactly one claim under the name after the restart reduction.
    expect(second.current().documents.filter((d) => d.kind === "Claim")).toHaveLength(1);
    expect(second.health()).toEqual({ documentSet: "current", warnings: [] });
  });

  it("(review P1) overlay write fault answers 500 JSON instead of crashing the process; the server keeps serving", async () => {
    const dir = tempDocuments();

    // A store whose overlay write throws synchronously on every append:
    // appendFileSync to a path inside a deleted directory → ENOENT (the
    // read-only-mount deployment fault in miniature — the file was readable
    // at start, so the overlay loads empty and the store is healthy).
    const deadDir = mkdtempSync(join(tmpdir(), "twill-dead-overlay-"));
    const deadOverlay = join(deadDir, OVERLAY_FILE);
    rmSync(deadDir, { recursive: true, force: true });

    const store = startStore(dir);
    untrack(store);
    store.close(); // frees the watchers on `dir` before store2 boots on it
    const store2 = startStore(dir, deadOverlay);
    const base = await serve(store2);

    const res = await fetch(`${base}/Claim/claim-fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validClaimBody("claim-fault")),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("internal error");

    // The append threw before any in-memory state changed: the claim was
    // never accepted, and the same server answers the next request fine.
    expect(store2.get("Claim", "claim-fault")).toBeUndefined();
    const discovery = await fetch(base);
    expect(discovery.status).toBe(200);
  });
});
