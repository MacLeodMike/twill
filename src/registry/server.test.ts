// HTTP surface tests (Task 6) — resolve, get, discovery, health,
// statusReport, claims 501 (workspace §8's endpoint list).
//
// Each test boots createServer(store).listen(0) against a fixture-backed
// temp-dir store (never the fixture dir itself) and speaks plain `fetch`.
// The raw fixtures are a lineage-linked trio sharing vol-2c4f1a, so every
// boot applies the same baseline mutation as Task 5's `tempBaseline` before
// start(): drop the worktree child, de-alias payments-repo (distinct
// fingerprint, parent link stripped).
// Servers, stores, and temp dirs are closed/removed in afterEach so
// vitest exits cleanly.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { start, type RegistryStore } from "./store.js";
import { createServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const openServers: Server[] = [];
const openStores: RegistryStore[] = [];
const tempDirs: string[] = [];

type Boot = { base: string; store: RegistryStore };

/** Boot a server on an ephemeral port over a fixture-backed temp-dir store. */
async function boot(mutate?: (dir: string) => void): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), "twill-http-"));
  cpSync(fixtures, dir, { recursive: true });
  // Good baseline: drop the worktree child, de-alias payments-repo (distinct
  // fingerprint, parent link stripped). Never mutate a lineaged child's
  // fingerprint.
  rmSync(join(dir, "Workspace", "payments-repo-feat-x.yaml"), { force: true });
  const p = join(dir, "Workspace", "payments-repo.yaml");
  writeFileSync(
    p,
    readFileSync(p, "utf8")
      .replace("vol-2c4f1a", "vol-payments-01")
      .replace("  parent: { kind: Workspace, name: workstation-repos }\n", ""),
  );
  mutate?.(dir);
  tempDirs.push(dir);

  const store = start(dir);
  openStores.push(store);
  const server = createServer(store);
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/twill/v1alpha1`, store };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function post(base: string, path: string, body: unknown, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const workstationConsumer = { agentLocation: "workstation", agentKind: "pi", principal: "user:example" };

/** Extra documents pinned into some boots (all fingerprints/ids distinct or lineaged). */
function writeExtraDocs(dir: string): void {
  // Non-inert but routes-empty: discovery's resolvable conjunct (routes
  // non-empty) must compose false even though doc.resolvable is true.
  writeFileSync(
    join(dir, "Workspace", "bare-desk.yaml"),
    `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: bare-desk }
spec:
  owner: user:test
  routes: []
  workspace:
    storageBacked: true
    accessMode: RWO
    storage: { id: ws-bare-desk, fingerprint: vol-bare-desk }
status: {}
`,
  );
  // Inert (missing spec.owner) but with routes: resolvable false via doc.resolvable.
  writeFileSync(
    join(dir, "Workspace", "ghost-ws.yaml"),
    `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: ghost-ws }
spec:
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/ghost
  workspace:
    storageBacked: true
    accessMode: RWO
    storage: { id: ws-ghost, fingerprint: vol-ghost }
status: {}
`,
  );
  // Child of workstation-repos: discovery must carry the `parent` ref, and
  // the shared fingerprint is lineaged (present parent) so the set loads.
  writeFileSync(
    join(dir, "Workspace", "workstation-repos-pr.yaml"),
    `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: workstation-repos-pr }
spec:
  owner: user:test
  parent: { kind: Workspace, name: workstation-repos }
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos/pr
  workspace:
    storageBacked: true
    accessMode: RWO
    storage: { id: ws-pr-child, fingerprint: vol-2c4f1a }
status: {}
`,
  );
}

describe("(a) GET / — discovery (core §10.3 shape)", () => {
  it("lists every document, inert included, with §10.3's resolvable composed from doc.resolvable AND routes-non-empty", async () => {
    const { base } = await boot(writeExtraDocs);
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const rows: Array<Record<string, unknown>> = await res.json();
    expect(rows.length).toBe(5); // both fixtures + the three extras, inert included

    const byName = new Map(rows.map((row) => [row["name"], row]));
    // Fixture rows: non-inert with routes → resolvable true, exact §10.3 shape.
    expect(byName.get("workstation-repos")).toEqual({
      kind: "Workspace",
      name: "workstation-repos",
      durable_id: "ws_01J8Z4-workstation-repos",
      resolvable: true,
    });
    expect(byName.get("payments-repo")).toEqual({
      kind: "Workspace",
      name: "payments-repo",
      durable_id: "ws_01J8Z4-payments-repo",
      resolvable: true,
    });
    // Non-inert but routes-empty → resolvable false (the routes conjunct).
    expect(byName.get("bare-desk")).toMatchObject({ resolvable: false });
    // Inert with routes → resolvable false (the document field).
    expect(byName.get("ghost-ws")).toMatchObject({ resolvable: false });
    // Lineaged child carries `parent`; parentless rows omit the key.
    expect(byName.get("workstation-repos-pr")).toEqual({
      kind: "Workspace",
      name: "workstation-repos-pr",
      durable_id: "ws-pr-child",
      resolvable: true,
      parent: { kind: "Workspace", name: "workstation-repos" },
    });
    for (const name of ["workstation-repos", "payments-repo", "bare-desk", "ghost-ws"]) {
      expect(byName.get(name)).not.toHaveProperty("parent");
    }
  });
});

describe("(b) POST /resolve — workstation consumer", () => {
  it("attaches via the local route with the never-observed default status", async () => {
    const { base } = await boot();
    const res = await post(base, "/resolve", {
      kind: "Workspace",
      name: "workstation-repos",
      consumer: workstationConsumer,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: string;
      descriptor: { kind: string; name: string; durable_id: string; route: { type: string }; status: { source: string } };
    };
    expect(json.result).toBe("Attached");
    expect(json.descriptor.kind).toBe("Workspace");
    expect(json.descriptor.name).toBe("workstation-repos");
    expect(json.descriptor.durable_id).toBe("ws_01J8Z4-workstation-repos");
    expect(json.descriptor.route.type).toBe("local");
    expect(json.descriptor.status.source).toBe("cached"); // never-observed default
  });
});

describe("(c) POST /resolve — unknown name", () => {
  it("returns NoMatch", async () => {
    const { base } = await boot();
    const res = await post(base, "/resolve", {
      kind: "Workspace",
      name: "no-such-workspace",
      consumer: workstationConsumer,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "NoMatch" });
  });
});

describe("(c') POST /resolve — inert document", () => {
  it("an inert document with routes resolves NoMatch (inert suppresses resolution; core §10.3)", async () => {
    const { base } = await boot(writeExtraDocs);
    const res = await post(base, "/resolve", {
      kind: "Workspace",
      name: "ghost-ws",
      consumer: workstationConsumer,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "NoMatch" });
  });
});

describe("(d) GET /<kind>/<name> — the stored document", () => {
  it("serves the verbatim envelope (doc.raw), 404 for unknown name/kind", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/Workspace/workstation-repos`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      apiVersion: string;
      kind: string;
      metadata: { name: string };
      spec: { workspace: { storage: { id: string; fingerprint: string } } };
    };
    // The verbatim YAML envelope, not a projection: every key is the file's.
    expect(doc.apiVersion).toBe("twill.bitwiseoperations.ca/v1alpha1");
    expect(doc.kind).toBe("Workspace");
    expect(doc.metadata.name).toBe("workstation-repos");
    // durable_id is derivable from the served document (core §4.3: Workspace storage.id).
    expect(doc.spec.workspace.storage.id).toBe("ws_01J8Z4-workstation-repos");
    expect(doc.spec.workspace.storage.fingerprint).toBe("vol-2c4f1a");

    const missing = await fetch(`${base}/Workspace/no-such-workspace`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain("no such document");

    const badKind = await fetch(`${base}/NotAKind/foo`);
    expect(badKind.status).toBe(404);
    expect(((await badKind.json()) as { error: string }).error).toContain("unknown kind");
  });
});

describe("(e) POST /<kind>/<name>/statusReport — missing document", () => {
  it("404s with a clear body and leaves the cache untouched (Review Focus #5)", async () => {
    const { base, store } = await boot();
    const res = await post(base, "/Workspace/no-such-workspace/statusReport", { ready: true });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("no such document");
    expect(store.statusCache.size).toBe(0);
  });
});

describe("(f) POST statusReport then resolve — the descriptor reflects the report", () => {
  it("merges the report into the status cache and the next resolve forwards it", async () => {
    const { base } = await boot();
    const report = await post(base, "/Workspace/workstation-repos/statusReport", {
      ready: true,
      progress: "mounted at /data/vol-2c4f1a",
    });
    expect(report.status).toBe(200);

    const res = await post(base, "/resolve", {
      kind: "Workspace",
      name: "workstation-repos",
      consumer: workstationConsumer,
    });
    const json = (await res.json()) as { descriptor: { status: { ready: boolean; progress: string; source: string } } };
    expect(json.descriptor.status.ready).toBe(true);
    expect(json.descriptor.status.progress).toBe("mounted at /data/vol-2c4f1a");
    expect(json.descriptor.status.source).toBe("live");
  });
});

describe("(g) claims surface — POST creates + PATCH releases (T2a); the single-claim GET keeps the T1 501", () => {
  it("POST /Claim/<name> → 400 on a malformed body (shape checks precede parent lookup; the full create contract lives in claims.test.ts)", async () => {
    const { base } = await boot();
    const res = await post(base, "/Claim/x", { spec: { claim: { principal: "user:test" } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("apiVersion");
  });

  it("PATCH /Claim/<name> → 404 on a missing claim (the release contract lives in claims.test.ts)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/Claim/x`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: { claim: { released: true } } }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("Claim/x");
  });

  it("GET /Claim/<name> → the same 501 (single-claim GET is not part of v1alpha1's surface)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/Claim/x`);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "claims unimplemented in T1 milestone", milestone: "T2" });
  });

  it("GET /claims without ?parent → 400 naming the parameter (Task 5 read-path)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/claims`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("parent");
  });

  it("POST /claims (plural) → 404 (never a real endpoint — creates go to POST /Claim/<name>)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("unknown path");
  });

  it("DELETE /Claim/<name> → 404 (the 501 is method-scoped; other methods fall through)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/Claim/x`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("DELETE");
  });
});

describe("PATCH /<kind>/<name> (non-Claim) — the overlay upsert (t25 Task 1)", () => {
  it("400s on a malformed envelope (the full upsert contract lives in upsert.test.ts)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/Workspace/workstation-repos`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("apiVersion");
  });
});

describe("GET /health", () => {
  it("serves store.health() verbatim", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documentSet: "current", warnings: [] });
  });
});

describe("statusReport semantics (beyond the 404)", () => {
  it("merges field-wise: a later {progress}-only report must not wipe a prior ready", async () => {
    const { base } = await boot();
    await post(base, "/Workspace/workstation-repos/statusReport", { ready: true, provisionable: false });
    await post(base, "/Workspace/workstation-repos/statusReport", { progress: "resyncing" });
    const res = await post(base, "/resolve", {
      kind: "Workspace",
      name: "workstation-repos",
      consumer: workstationConsumer,
    });
    const json = (await res.json()) as { descriptor: { status: { ready: boolean; provisionable: boolean; progress: string } } };
    expect(json.descriptor.status.ready).toBe(true);
    expect(json.descriptor.status.provisionable).toBe(false);
    expect(json.descriptor.status.progress).toBe("resyncing");
  });

  it("stamps now (RFC 3339) when asOf is absent; preserves a submitted asOf verbatim", async () => {
    const { base, store } = await boot();
    const before = Date.now();
    const first = await post(base, "/Workspace/workstation-repos/statusReport", { ready: true });
    // The response body is the merged status surface (core §8's six fields).
    const surface = (await first.json()) as { source: string; asOf: string };
    expect(surface.source).toBe("live");
    expect(surface.asOf).toBeDefined();
    const asOf = new Date(surface.asOf);
    expect(Number.isNaN(asOf.getTime())).toBe(false);
    expect(Math.abs(asOf.getTime() - before)).toBeLessThan(10_000);

    await post(base, "/Workspace/workstation-repos/statusReport", { progress: "explicit", asOf: "2026-10-04T03:12:11Z" });
    expect(store.statusCache.get("Workspace/workstation-repos")?.asOf).toBe("2026-10-04T03:12:11Z");
  });

  it("ignores a submitted claimedBy (registry-derived) with a warning log", async () => {
    const { base, store } = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(base, "/Workspace/workstation-repos/statusReport", {
      ready: true,
      claimedBy: [{ name: "c1", owner: "user:test", principal: "user:test", claimedOn: {} }],
    });
    expect(res.status).toBe(200);
    const entry = store.statusCache.get("Workspace/workstation-repos");
    expect(entry?.claimedBy).toEqual([]); // never taken from a report
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((args) => args.map(String).join(" "));
    expect(messages.some((m) => m.includes("claimedBy"))).toBe(true);
  });

  it("type-checks the report fields: a non-boolean ready → 400, cache untouched", async () => {
    const { base, store } = await boot();
    const res = await post(base, "/Workspace/workstation-repos/statusReport", { ready: "yes" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ready");
    expect(store.statusCache.size).toBe(0);
  });
});

describe("/resolve body validation", () => {
  it("malformed JSON → 400 with an error body", async () => {
    const { base } = await boot();
    const res = await post(base, "/resolve", "{not json", { headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("malformed JSON");
  });

  it("missing kind / name / consumer (or consumer fields) → 400", async () => {
    const { base } = await boot();
    const noKind = await post(base, "/resolve", { name: "workstation-repos", consumer: workstationConsumer });
    expect(noKind.status).toBe(400);
    const noName = await post(base, "/resolve", { kind: "Workspace", consumer: workstationConsumer });
    expect(noName.status).toBe(400);
    const noConsumer = await post(base, "/resolve", { kind: "Workspace", name: "workstation-repos" });
    expect(noConsumer.status).toBe(400);
    const missingPrincipal = await post(base, "/resolve", {
      kind: "Workspace",
      name: "workstation-repos",
      consumer: { agentLocation: "workstation", agentKind: "pi" },
    });
    expect(missingPrincipal.status).toBe(400);
    const emptyBody = await post(base, "/resolve", "");
    expect(emptyBody.status).toBe(400);
  });
});

describe("unknown paths", () => {
  it("404s outside the surface (root, unknown segment, extra depth)", async () => {
    const { base } = await boot();
    const origin = base.split("/twill")[0] ?? "http://127.0.0.1";
    const root = await fetch(origin);
    expect(root.status).toBe(404);
    expect(((await root.json()) as { error: string }).error).toBeDefined();

    const unknown = await fetch(`${base}/nope`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBeDefined();

    const deep = await fetch(`${base}/Workspace/workstation-repos/extra`);
    expect(deep.status).toBe(404);
    expect(((await deep.json()) as { error: string }).error).toBeDefined();
  });
});