import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDirectory } from "./loader.js";
import { resolve as resolveWs, type ResolveStore } from "./resolver.js";
import { documentKey } from "./lineage.js";
import type { Consumer, RouteError } from "./resolver.js";
import type { FabricDocument, Route } from "./document.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

const workstationConsumer: Consumer = { agentLocation: "workstation", agentKind: "pi", principal: "user:example" };
const clusterConsumer: Consumer = { agentLocation: "cluster", agentKind: "pi", principal: "user:example" };

function fixtureStore(): ResolveStore {
  const { documents } = loadDirectory(fixtures);
  return {
    get: (kind, name) => {
      const doc = documents.find((d) => d.kind === kind && d.name === name);
      return doc === undefined || !doc.resolvable ? undefined : doc;
    },
    statusCache: new Map(),
  };
}

function docWithRoutes(routes: Route[]): FabricDocument {
  return {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Workspace",
    name: "custom",
    labels: {},
    owner: "user:test",
    routes,
    kindSpec: { storage: { id: "ws_custom", fingerprint: "vol-custom" } },
    resolvable: true,
    inertReasons: [],
    sourcePath: "test/custom.yaml",
    raw: {},
  };
}

function storeWithDoc(doc: FabricDocument): ResolveStore {
  return { get: (_k, n) => (n === doc.name ? doc : undefined), statusCache: new Map() };
}

describe("resolve (core §7)", () => {
  it("(a) workstation consumer resolves workstation-repos via the local route", () => {
    const result = resolveWs("Workspace", "workstation-repos", workstationConsumer, fixtureStore());
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.kind).toBe("Workspace");
    expect(result.descriptor.name).toBe("workstation-repos");
    expect(result.descriptor.durable_id).toBe("ws_01J8Z4-workstation-repos");
    expect(result.descriptor.route).toEqual({ match: { agentLocation: "workstation" }, type: "local", path: "~/repos" });
    // Never-observed default (cold-workspace pin): provisionable selects.
    expect(result.descriptor.status).toEqual({
      ready: false,
      provisionable: true,
      claimedBy: [],
      progress: "no provider report yet",
      asOf: null,
      source: "cached",
    });
  });

  it("(b) cluster consumer attaches via the ssh route (order: local route skipped as non-matching)", () => {
    const result = resolveWs("Workspace", "workstation-repos", clusterConsumer, fixtureStore());
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.route).toEqual({
      match: { agentLocation: "cluster" },
      type: "ssh",
      address: "workstation",
      path: "/data/repos",
    });
  });

  it("(c) unknown name → NoMatch", () => {
    const result = resolveWs("Workspace", "no-such-workspace", workstationConsumer, fixtureStore());
    expect(result).toEqual({ result: "NoMatch" });
  });

  it("(d) no matching route (agentLocation mars) → NoMatch, not Unreachable", () => {
    const result = resolveWs("Workspace", "workstation-repos", { ...workstationConsumer, agentLocation: "mars" }, fixtureStore());
    expect(result).toEqual({ result: "NoMatch" });
  });

  it("(e) unknown route type first, selectable ssh second → Attached via the second (unknown type = per-route error, continue)", () => {
    const doc = docWithRoutes([
      { match: { agentLocation: "cluster" }, type: "bogus", weird: true },
      { match: { agentLocation: "cluster" }, type: "ssh", address: "workstation", path: "/data/repos" },
    ]);
    const result = resolveWs("Workspace", "custom", { ...clusterConsumer }, storeWithDoc(doc));
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.route["type"]).toBe("ssh");
    expect(result.descriptor.route["address"]).toBe("workstation");
  });

  it("(e') unknown route type on the only matching route → Unreachable with a per-route error", () => {
    const doc = docWithRoutes([
      { match: { agentLocation: "cluster" }, type: "bogus", weird: true },
    ]);
    const result = resolveWs("Workspace", "custom", clusterConsumer, storeWithDoc(doc));
    expect(result.result).toBe("Unreachable");
    if (result.result !== "Unreachable") return;
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.route).toEqual({ match: { agentLocation: "cluster" }, type: "bogus", weird: true });
    expect(result.errors[0]!.reason).toContain("unknown route type");
  });

  it("(f) empty-string match value never matches (route silently skipped, not an error)", () => {
    const doc = docWithRoutes([
      { match: { agentLocation: "" }, type: "local", path: "/nowhere" },
      { match: { agentLocation: "cluster" }, type: "ssh", address: "workstation", path: "/data/repos" },
    ]);
    const result = resolveWs("Workspace", "custom", clusterConsumer, storeWithDoc(doc));
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.route["type"]).toBe("ssh");
  });

  it("(f') empty-string match on the only route → NoMatch (no error)", () => {
    const doc = docWithRoutes([{ match: { agentLocation: "" }, type: "local", path: "/nowhere" }]);
    const result = resolveWs("Workspace", "custom", clusterConsumer, storeWithDoc(doc));
    expect(result).toEqual({ result: "NoMatch" });
  });

  it("anonymous consumer (principal: \"\") matches only routes without a principal key", () => {
    const doc = docWithRoutes([
      { match: { principal: "user:other" }, type: "local", path: "/targeted" },
      { match: { agentLocation: "workstation" }, type: "local", path: "/open" },
    ]);
    const anonymous: Consumer = { agentLocation: "workstation", agentKind: "pi", principal: "" };
    const result = resolveWs("Workspace", "custom", anonymous, storeWithDoc(doc));
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.route).toEqual({ match: { agentLocation: "workstation" }, type: "local", path: "/open" });
  });

  it("named consumer matches a route targeting their principal", () => {
    const doc = docWithRoutes([
      { match: { principal: "user:example" }, type: "local", path: "/mine" },
    ]);
    const result = resolveWs("Workspace", "custom", workstationConsumer, storeWithDoc(doc));
    expect(result.result).toBe("Attached");
  });

  it("all matching routes not selectable → Unreachable with an error per rejected route", () => {
    const doc = docWithRoutes([
      { match: { agentLocation: "cluster" }, type: "ssh", address: "a1", path: "/p1" },
      { match: { agentLocation: "cluster" }, type: "local", path: "/p2" },
    ]);
    const store: ResolveStore = {
      get: (_k, n) => (n === doc.name ? doc : undefined),
      statusCache: new Map([[
        documentKey(doc),
        { ready: false, provisionable: false, claimedBy: [], progress: "down", asOf: "2026-10-04T03:12:11Z", source: "cached" },
      ]]),
    };
    const result = resolveWs("Workspace", "custom", clusterConsumer, store);
    expect(result.result).toBe("Unreachable");
    if (result.result !== "Unreachable") return;
    expect(result.errors.length).toBe(2);
    expect(result.errors.map((e: RouteError) => e.reason).every((r) => r.includes("not selectable"))).toBe(true);
    expect(result.errors[0]!.route["address"]).toBe("a1");
    expect(result.errors[1]!.route["path"]).toBe("/p2");
  });

  it("cached live report selects via ready and is forwarded verbatim in the descriptor", () => {
    const store = fixtureStore();
    store.statusCache.set("Workspace/workstation-repos", {
      ready: true,
      provisionable: false,
      claimedBy: [],
      progress: "mounted at /data/vol-2c4f1a",
      asOf: "2026-10-04T03:12:11Z",
      source: "live",
    });
    const result = resolveWs("Workspace", "workstation-repos", workstationConsumer, store);
    expect(result.result).toBe("Attached");
    if (result.result !== "Attached") return;
    expect(result.descriptor.status).toEqual({
      ready: true,
      provisionable: false,
      claimedBy: [],
      progress: "mounted at /data/vol-2c4f1a",
      asOf: "2026-10-04T03:12:11Z",
      source: "live",
    });
  });
});