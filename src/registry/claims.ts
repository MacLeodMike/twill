// Claim document validation (T2a Task 1) — the create path for
// POST /Claim/<name>: envelope checks against core §9's pinned shape,
// POST-time parent existence (core §9: "Missing parents are rejected at
// POST time"), the §8.4 claimedOn consistency rule (a claim occupies the
// storage it claims against), and the workspace §8 claim collision rule
// (POST against an existing Claim name is rejected).
//
// `validateClaimCreate` is the single validator; the route layer
// (routes.ts) maps its failure statuses straight onto the HTTP response.
// Write-time set validation (§8.3 over watched ∪ overlay ∪ new) is the
// store's job — `store.appendOverlay` — not this module's.

import {
  API_VERSION,
  durableIdOf,
  isRecord,
  type FabricDocument,
  type Kind,
} from "./document.js";
import type { RegistryStore } from "./store.js";

/** Failure statuses the route layer can emit for a claim create. */
type ClaimFailureStatus = 400 | 409 | 422;

export type ClaimValidation =
  | { ok: true; doc: FabricDocument }
  | { ok: false; status: ClaimFailureStatus; error: string };

type ClaimFailure = { ok: false; status: ClaimFailureStatus; error: string };

function fail(status: ClaimFailureStatus, error: string): ClaimFailure {
  return { ok: false, status, error };
}

/** A required non-empty string field, else a 400 naming the path. */
function readRequiredString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | ClaimFailure {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    return fail(400, `${path} is required (non-empty string)`);
  }
  return value;
}

/**
 * Validate a POST /Claim/<urlName> body and produce the claim document to
 * append (core §9). `raw` is the parsed JSON body; the claim's name comes
 * from the URL — a body `metadata.name` that disagrees is a 400.
 *
 * Failure statuses: 400 malformed envelope/fields, 409 the two conflicts
 * (missing parent — Review Focus #1; existing Claim name — workspace §8's
 * claim collision rule), 422 claimedOn consistency against the parent
 * (§8.4: the claim occupies the storage it claims against).
 *
 * Checks run cheapest-shape-first; the parent lookup (409s) precedes the
 * claimedOn consistency checks (422s) since those read the parent's fields.
 */
export function validateClaimCreate(raw: unknown, urlName: string, store: RegistryStore): ClaimValidation {
  if (!isRecord(raw)) return fail(400, "claim body must be a JSON object");

  // Envelope (core §3/§9): apiVersion, kind, metadata.name, spec.
  if (raw["apiVersion"] !== API_VERSION) {
    return fail(400, `apiVersion must be ${API_VERSION}`);
  }
  if (raw["kind"] !== "Claim") {
    return fail(400, `kind must be Claim (got ${JSON.stringify(raw["kind"])})`);
  }
  const metadata = isRecord(raw["metadata"]) ? raw["metadata"] : undefined;
  const bodyName = metadata?.["name"];
  if (typeof bodyName === "string" && bodyName !== "" && bodyName !== urlName) {
    return fail(400, `metadata.name ${JSON.stringify(bodyName)} does not match the URL name ${JSON.stringify(urlName)}`);
  }
  const spec = raw["spec"];
  if (!isRecord(spec)) return fail(400, "spec is required (object)");

  const owner = readRequiredString(spec, "owner", "spec.owner");
  if (typeof owner !== "string") return owner;
  const routes = spec["routes"];
  if (routes !== undefined && !Array.isArray(routes)) {
    return fail(400, "spec.routes must be an array (claims route nothing: use [])");
  }
  const claim = spec["claim"];
  if (!isRecord(claim)) return fail(400, "spec.claim is required (object)");
  const parentValue = spec["parent"];
  if (!isRecord(parentValue)) return fail(400, "spec.parent {kind, name} is required");
  const parentKind = parentValue["kind"];
  const parentName = parentValue["name"];
  if (typeof parentKind !== "string" || parentKind === "" || typeof parentName !== "string" || parentName === "") {
    return fail(400, "spec.parent requires non-empty string kind and name");
  }

  // Claim spec fields (core §9 shape; Global Constraints list).
  const claimId = readRequiredString(claim, "id", "spec.claim.id");
  if (typeof claimId !== "string") return claimId;
  const principal = readRequiredString(claim, "principal", "spec.claim.principal");
  if (typeof principal !== "string") return principal;
  if (claim["storageBacked"] !== false) {
    return fail(400, "spec.claim.storageBacked must be false (claims are not storage-backed, §4.3)");
  }
  const claimRoute = claim["route"];
  // Verbatim copy of the resolved route (core §9): present and an object;
  // T2a does not verify it against any resolved route — provider binding is
  // by exact-match convention.
  if (!isRecord(claimRoute)) return fail(400, "spec.claim.route is required (object — the verbatim resolved route)");
  if ("parameters" in claim && !isRecord(claim["parameters"])) {
    return fail(400, "spec.claim.parameters must be an object when present");
  }
  const released = claim["released"];
  if (released !== undefined && typeof released !== "boolean") {
    return fail(400, "spec.claim.released must be a boolean when present (omitted defaults to false)");
  }

  // claimedOn (§8.4): durable_id always; fingerprint required iff the
  // parent is storage-backed (Workspace in v1alpha1).
  const claimedOn = claim["claimedOn"];
  if (!isRecord(claimedOn)) return fail(400, "spec.claim.claimedOn {fingerprint?, durable_id} is required");
  const claimedDurableId = claimedOn["durable_id"];
  if (typeof claimedDurableId !== "string" || claimedDurableId === "") {
    return fail(400, "spec.claim.claimedOn.durable_id is required (non-empty string)");
  }
  const claimedFingerprint = claimedOn["fingerprint"];
  if (claimedFingerprint !== undefined && (typeof claimedFingerprint !== "string" || claimedFingerprint === "")) {
    return fail(400, "spec.claim.claimedOn.fingerprint must be a non-empty string when present");
  }

  // Claim collision rule (workspace §8): the name must be unique across
  // the merged set (watched ∪ overlay) — a live claim cannot be silently
  // overwritten by another consumer.
  if (store.get("Claim", urlName) !== undefined) {
    return fail(409, `claim name already exists: Claim/${urlName} (POST cannot overwrite a live claim; PATCH releases)`);
  }

  // POST-time parent existence (core §9): the parent must be an existing,
  // registered document. A parent deleted *after* the claim exists is an
  // orphan (inert + health warning), never a set-level rejection.
  const parent = store.get(parentKind as Kind, parentName);
  if (parent === undefined) {
    return fail(409, `claim parent ${parentKind}/${parentName} does not exist in the document set (claims name existing, registered resources only)`);
  }

  // §8.4 consistency: the claim must occupy the object it claims against.
  const parentDurableId = durableIdOf(parent);
  if (claimedDurableId !== parentDurableId) {
    return fail(
      422,
      `spec.claim.claimedOn.durable_id ${JSON.stringify(claimedDurableId)} does not equal the parent's durable id ` +
        `${JSON.stringify(parentDurableId)} (${parentKind}/${parentName})`,
    );
  }
  if (parent.kind === "Workspace") {
    const parentFingerprint = parent.kindSpec["storage"];
    const expected =
      isRecord(parentFingerprint) && typeof parentFingerprint["fingerprint"] === "string"
        ? parentFingerprint["fingerprint"]
        : undefined;
    if (claimedFingerprint !== expected) {
      return fail(
        422,
        `spec.claim.claimedOn.fingerprint ${JSON.stringify(claimedFingerprint)} does not equal the parent's ` +
          `spec.workspace.storage.fingerprint ${JSON.stringify(expected)} (claims occupy the storage they claim against, §8.4)`,
      );
    }
  } else if (claimedFingerprint !== undefined) {
    return fail(
      422,
      `spec.claim.claimedOn.fingerprint must be absent for non-storage-backed parent ${parentKind}/${parentName} (§8.4)`,
    );
  }

  // The document the overlay stores: `released` defaults to false so every
  // stored claim carries the field explicitly (T2 reads it on PATCH).
  const docRaw: Record<string, unknown> = {
    ...raw,
    apiVersion: API_VERSION,
    kind: "Claim",
    metadata: { ...(metadata ?? {}), name: urlName },
    spec: {
      ...spec,
      owner,
      routes: routes ?? [],
      claim: { ...claim, storageBacked: false, released: released ?? false },
      parent: { kind: parentKind, name: parentName },
    },
  };
  if (!("status" in docRaw)) docRaw["status"] = {};

  const kindSpecValue = (docRaw["spec"] as Record<string, unknown>)["claim"];
  const doc: FabricDocument = {
    apiVersion: API_VERSION,
    kind: "Claim",
    name: urlName,
    labels: readLabels(metadata),
    owner,
    routes: [],
    kindSpec: isRecord(kindSpecValue) ? kindSpecValue : {},
    parent: { kind: parentKind, name: parentName },
    // Claims are never attach targets (routes: [] ⇒ NoMatch); resolvable
    // here means "a well-formed member of the document set" — discovery's
    // resolvable conjunct (routes non-empty) composes the §10.3 answer.
    resolvable: true,
    inertReasons: [],
    sourcePath: "<overlay>",
    raw: docRaw,
  };
  return { ok: true, doc };
}

function readLabels(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const labels = metadata?.["labels"];
  if (!isRecord(labels)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
