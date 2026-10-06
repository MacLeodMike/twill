import { describe, it, expect } from "vitest";
import { ancestorSet, documentKey, rejectCheck } from "./lineage.js";
import { API_VERSION, type FabricDocument, type ParentRef } from "./document.js";

/** A minimal in-memory Workspace document (no filesystem). */
function wsDoc(
  name: string,
  storageId: string,
  opts: { fingerprint?: string; parent?: ParentRef } = {},
): FabricDocument {
  const storage: Record<string, unknown> = { id: storageId };
  if (opts.fingerprint !== undefined) storage["fingerprint"] = opts.fingerprint;
  return {
    apiVersion: API_VERSION,
    kind: "Workspace",
    name,
    labels: {},
    owner: "user:test",
    routes: [],
    kindSpec: { storageBacked: true, storage },
    parent: opts.parent,
    resolvable: true,
    inertReasons: [],
    sourcePath: `test/${name}.yaml`,
    raw: {},
  };
}

function keyByName(documents: FabricDocument[]): Map<string, FabricDocument> {
  return new Map(documents.map((d) => [documentKey(d), d]));
}

describe("rejectCheck (§8.3 lineage rule)", () => {
  it("accepts parent/child and siblings under one present root with equal fingerprints", () => {
    const root = wsDoc("workstation-repos", "ws_01J8Z4-workstation-repos", { fingerprint: "vol-2c4f1a" });
    const worktree = wsDoc("payments-repo-feat-x", "ws_01J8Z4-payments-repo-feat-x", {
      fingerprint: "vol-2c4f1a",
      parent: { kind: "Workspace", name: "workstation-repos" },
    });
    const sibling = wsDoc("payments-repo-main", "ws_01J8Z4-payments-repo-main", {
      fingerprint: "vol-2c4f1a",
      parent: { kind: "Workspace", name: "workstation-repos" },
    });
    const documents = [root, worktree, sibling];

    const result = rejectCheck(documents);
    expect(result.rejected).toBe(false);
    expect(result.reason).toBeUndefined();

    // ancestorSet is self-inclusive and walks transitive spec.parent.
    const byName = keyByName(documents);
    expect(ancestorSet(worktree, byName)).toEqual(
      new Set(["Workspace/payments-repo-feat-x", "Workspace/workstation-repos"]),
    );
    expect(ancestorSet(root, byName)).toEqual(new Set(["Workspace/workstation-repos"]));
  });

  it("rejects two unrelated roots with equal fingerprints, naming both", () => {
    const a = wsDoc("workstation-repos", "ws_01J8Z4-workstation-repos", { fingerprint: "vol-2c4f1a" });
    const b = wsDoc("cluster-repos", "ws_01J8Z4-cluster-repos", { fingerprint: "vol-2c4f1a" });

    const result = rejectCheck([a, b]);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("Workspace/workstation-repos");
    expect(result.reason).toContain("Workspace/cluster-repos");
    expect(result.reason).toContain("vol-2c4f1a");
  });

  it("rejects two roots citing the same missing parent (lineage requires presence)", () => {
    const a = wsDoc("root-a", "ws_a", { fingerprint: "vol-x", parent: { kind: "Workspace", name: "ghost" } });
    const b = wsDoc("root-b", "ws_b", { fingerprint: "vol-x", parent: { kind: "Workspace", name: "ghost" } });
    const documents = [a, b];

    // Both ancestor sets cite the missing parent, but "Workspace/ghost" is
    // not a loaded document — the shared citation confers no lineage.
    const byName = keyByName(documents);
    expect(ancestorSet(a, byName)).toEqual(new Set(["Workspace/root-a", "Workspace/ghost"]));
    expect(ancestorSet(b, byName)).toEqual(new Set(["Workspace/root-b", "Workspace/ghost"]));

    const result = rejectCheck(documents);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("Workspace/root-a");
    expect(result.reason).toContain("Workspace/root-b");
  });

  it("rejects a duplicate durable id regardless of fingerprint or lineage", () => {
    const a = wsDoc("workstation-repos", "ws_01J8Z4-workstation-repos", { fingerprint: "vol-2c4f1a" });
    const b = wsDoc("payments-repo", "ws_01J8Z4-workstation-repos", { fingerprint: "vol-9d3b77" });

    const result = rejectCheck([a, b]);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("ws_01J8Z4-workstation-repos");
  });

  it("rejects a parent cycle, and cycle rejection precedes lineage computation", () => {
    // a → b → a; the pair also collides on fingerprint, so only correct
    // ordering (cycle first, §4.2) yields the cycle reason.
    const a = wsDoc("alpha", "ws_alpha", { fingerprint: "vol-c", parent: { kind: "Workspace", name: "beta" } });
    const b = wsDoc("beta", "ws_beta", { fingerprint: "vol-c", parent: { kind: "Workspace", name: "alpha" } });

    const result = rejectCheck([a, b]);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain("cycle");
    expect(result.reason).toContain("Workspace/alpha");
    expect(result.reason).toContain("Workspace/beta");
  });
});
