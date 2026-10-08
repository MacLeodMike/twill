// Child document construction (T2.5 Task 4) — the deterministic §5.3
// rules, extracted from the provider loop (Task 3 built them inline). A
// fulfilled worktree claim becomes a child Workspace document PATCHed into
// the overlay; this module is the single place that document is built.
//
// The rules (provider spec §5 step 3, workspace §6 step 4):
//   metadata.name              = <parent-name>-<worktreeName>
//   spec.workspace.storage.id  = <parent-storage.id>-<worktreeName>
//   spec.parent                = {kind: "Workspace", name: <parent-name>}
//   storage.fingerprint        = the parent's (lineage: the child shares
//                                the parent's storage identity — §8.3's
//                                fingerprint-collision rule passes because
//                                the ancestor sets intersect at the parent)
//   routes                     = the claim's spec.claim.route copied with
//                                `path` → the materialized child path and
//                                `precondition` dropped (the child is
//                                already materialized); `match`/`type` —
//                                and every other key — preserved exactly
//
// The identity rule (Review Focus #3): name and storage id are a PURE
// function of (parent, worktreeName) — nothing else feeds them, so a
// duplicate claim re-yields the same child and the PATCH upsert converges
// instead of minting a divergent document. `childNameFor` is that pure
// derivation for the name; the loop uses it for its idempotence check and
// PATCH URL so the check, the URL, and the built document can never
// disagree on the child's name.
//
// The return is the raw wire envelope (metadata/spec/status) — exactly
// what PATCH /<kind>/<name> consumes and what the registry's loader
// projects into its internal FabricDocument. The provider authors wire
// documents; it never holds the registry's projection.

import { API_VERSION, type Route } from "../registry/document.js";

/** A claim envelope as served by GET /claims (the raw YAML projection). */
export type ClaimEnvelope = {
  metadata?: { name?: string };
  spec?: {
    parent?: { kind?: string; name?: string };
    claim?: {
      route?: unknown;
      parameters?: unknown;
      released?: boolean;
    };
  };
};

/** The deterministic child name (§5.3): `<parent-name>-<worktreeName>`. */
export function childNameFor(parentName: string, worktreeName: string): string {
  return `${parentName}-${worktreeName}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Build the child Workspace document for a fulfilled worktree claim.
 *
 * `parent` is the parent Workspace envelope as GET /Workspace/<name>
 * serves it (doc.raw); `claim` is the claim envelope as GET /claims serves
 * it; `childPath` is the materialized path the claim's preconditions
 * produced.
 *
 * Throws on a violated caller contract — a claim with no worktreeName
 * (cold-root claims build NO child, spec §5 step 4), a claim with no
 * route, or a parent envelope without metadata.name. The loop guarantees
 * all three before calling; a throw here is a programming error, never a
 * claim-validation path (claims fail via statusReport, not exceptions).
 */
export function buildChildDocument(
  parent: Record<string, unknown>,
  claim: ClaimEnvelope,
  childPath: string,
): Record<string, unknown> {
  const parentMetadata = asRecord(parent["metadata"]) ?? {};
  const parentNameRaw = parentMetadata["name"];
  if (typeof parentNameRaw !== "string" || parentNameRaw === "") {
    throw new Error("buildChildDocument requires the parent envelope's metadata.name");
  }
  const parentName = parentNameRaw;

  const routeRaw = asRecord(claim.spec?.claim?.route);
  if (routeRaw === undefined) {
    throw new Error("buildChildDocument requires claim.spec.claim.route (a route object)");
  }
  const route = routeRaw as Route;

  const parameters = asRecord(claim.spec?.claim?.parameters) ?? {};
  const worktreeNameRaw = parameters["worktreeName"];
  if (typeof worktreeNameRaw !== "string" || worktreeNameRaw === "") {
    throw new Error(
      "buildChildDocument requires claim.spec.claim.parameters.worktreeName (a cold-root claim builds no child)",
    );
  }
  const worktreeName = worktreeNameRaw;

  const parentSpec = asRecord(parent["spec"]) ?? {};
  const parentWorkspace = asRecord(parentSpec["workspace"]) ?? {};
  const parentStorage = asRecord(parentWorkspace["storage"]) ?? {};
  const parentStorageId = typeof parentStorage["id"] === "string" ? parentStorage["id"] : parentName;
  const parentFingerprint = parentStorage["fingerprint"];
  const owner = typeof parentSpec["owner"] === "string" ? parentSpec["owner"] : "";

  // The claim route copied: path → childPath, precondition dropped,
  // match/type (and every other key) preserved exactly.
  const childRoute: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(route)) {
    if (key === "precondition") continue;
    childRoute[key] = value;
  }
  childRoute["path"] = childPath;

  const child: Record<string, unknown> = {
    apiVersion: API_VERSION,
    kind: "Workspace",
    metadata: { name: childNameFor(parentName, worktreeName) },
    spec: {
      owner,
      routes: [childRoute],
      workspace: {
        ...parentWorkspace,
        storage: {
          ...parentStorage,
          id: `${parentStorageId}-${worktreeName}`,
          fingerprint: parentFingerprint,
        },
      },
      parent: { kind: "Workspace", name: parentName },
    },
    status: {},
  };
  // Preserve the parent's labels (workspace-class etc.) when present.
  const labels = parentMetadata["labels"];
  if (asRecord(labels) !== undefined) {
    (child["metadata"] as Record<string, unknown>)["labels"] = labels;
  }
  return child;
}
