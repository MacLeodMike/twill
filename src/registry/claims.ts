// Claim document validation (T2a Tasks 1+2) — POST /Claim/<name> create
// and PATCH /Claim/<name> release. Create: envelope checks against core
// §9's pinned shape, POST-time parent existence (core §9: "Missing parents
// are rejected at POST time"), the §8.4 claimedOn consistency rule (a
// claim occupies the storage it claims against), and the workspace §8
// claim collision rule (POST against an existing Claim name is rejected).
// Release (Task 2): the only permitted mutation — the PATCH body carries
// the full claim envelope and, after normalization, may differ from the
// stored claim only by `spec.claim.released: true`; anything else is a 409
// naming the offending field(s).
//
// The validators return the document to append; the route layer
// (routes.ts) maps failure statuses straight onto the HTTP response.
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

/** Failure statuses the route layer can emit for a claim release (PATCH). */
type ClaimReleaseFailureStatus = 400 | 404 | 409;

export type ClaimValidation =
  | { ok: true; doc: FabricDocument }
  | { ok: false; status: ClaimFailureStatus; error: string };

export type ClaimReleaseValidation =
  | { ok: true; doc: FabricDocument }
  | { ok: false; status: ClaimReleaseFailureStatus; error: string };

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
  return validateClaimEnvelope(raw, urlName, store, { allowExisting: false });
}

/**
 * The shared claim-body validator behind both claim writes. With
 * `allowExisting: false` this is create (POST): an existing Claim of the
 * URL name is a 409 collision. With `allowExisting: true` (PATCH release)
 * the target claim necessarily already exists, so the name-collision check
 * is skipped — every other check (envelope shape, §8.4 claimedOn
 * consistency, POST-time parent existence) applies to the PATCH body too,
 * since it carries the full claim envelope.
 */
function validateClaimEnvelope(
  raw: unknown,
  urlName: string,
  store: RegistryStore,
  opts: { allowExisting: boolean },
): ClaimValidation {
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
  // overwritten by another consumer. Skipped for the PATCH path: the claim
  // being patched exists by definition.
  if (!opts.allowExisting && store.get("Claim", urlName) !== undefined) {
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

/**
 * Validate a PATCH /Claim/<urlName> body (workspace §8's claim collision
 * rule: a live claim cannot be silently overwritten — release is the only
 * permitted mutation). The PATCH body must carry the full claim envelope;
 * after normalization the only allowed difference vs the stored claim is
 * `spec.claim.released: true`.
 *
 * Failure statuses: 404 the claim is absent (or malformed path); 400 the
 * body is not a well-formed claim envelope (envelope/§8.4 checks are shared
 * with create — a PATCH that fails them is malformed, never a conflict);
 * 409 names every field where the submitted claim differs from the stored
 * one beyond the release flag. Idempotent: PATCHing an already-released
 * claim with `released: true` is an ok no-op.
 *
 * The returned doc carries the released claim; the route appends it through
 * the same overlay seam as create (the overlay records latest-per-name).
 */
export function validateClaimRelease(
  urlName: string,
  raw: unknown,
  store: RegistryStore,
): ClaimReleaseValidation {
  if (urlName === "") return releaseFail(400, "claim name is required (PATCH /Claim/<name>)");

  // The release target: latest-per-name from the merged set (watched ∪ overlay).
  const stored = store.get("Claim", urlName);
  if (stored === undefined) {
    return releaseFail(404, `no such claim: Claim/${urlName} (PATCH releases an existing claim only)`);
  }

  // Reuse the create validator for envelope shape and the §8.4 claimedOn
  // consistency checks. The two create-path conflicts cannot fire here: the
  // name exists (it is the release target), and the claim's own existence
  // implies its parent is registered (POST-time parent existence, core §9).
  const checked = validateClaimEnvelope(raw, urlName, store, { allowExisting: true });
  if (!checked.ok) return { ok: false, status: checked.status as 400, error: checked.error };

  // Field-wise diff of normalized submitted vs normalized stored: the
  // release flag is the only permitted difference.
  const violations = claimFieldDiffs(stored.raw, checked.doc.raw);
  if (violations.length > 0) {
    return releaseFail(
      409,
      `claim PATCH may only set spec.claim.released: true (claim collision rule, workspace §8); ` +
        `offending field(s): ${violations.join(", ")}`,
    );
  }
  if (!isRecord(raw)) {
    // Unreachable: the shared envelope validator rejects non-records.
    // Keeps the submitted `released` read below type-safe without re-narrowing.
    return releaseFail(400, "claim body must be a JSON object");
  }
  const submittedClaim = (raw as Record<string, unknown>)["spec"] as Record<string, unknown>;
  const submittedReleased = (submittedClaim["claim"] as Record<string, unknown>)["released"];
  const storedReleased = stored.kindSpec["released"] === true;

  // Direction rule (the release half of the collision rule): the only
  // permitted release change is false → true. An unchanged flag (true on an
  // already-released claim) is an idempotent no-op; flipping true → false is
  // a forbidden re-claim of a released claim.
  if (submittedReleased === false && storedReleased) {
    return releaseFail(
      409,
      "spec.claim.released may only transition false → true: a released claim cannot be re-claimed " +
        "(claim collision rule, workspace §8)",
    );
  }
  if (submittedReleased !== true) {
    // No field difference and no release: nothing to append (submitted is
    // byte-identical to the stored, still-unreleased claim).
    return { ok: true, doc: stored };
  }
  return { ok: true, doc: checked.doc };
}

function releaseFail(status: ClaimReleaseFailureStatus, error: string): { ok: false; status: ClaimReleaseFailureStatus; error: string } {
  return { ok: false, status, error };
}

/**
 * Dot-paths where the normalized stored claim and the normalized submitted
 * claim differ — excluding `spec.claim.released` (the release flag is
 * adjudicated separately by the direction rule). Compares the create-
 * normalized projections (Task 1's validateClaimCreate output: URL-named
 * metadata, `released` defaulted in, routes defaulted to []), so envelope
 * trivia like an omitted metadata.labels never reads as a mutation.
 */
function claimFieldDiffs(storedRaw: unknown, submittedRaw: unknown): string[] {
  const diffs: string[] = [];
  diffValue("", storedRaw, submittedRaw, diffs);
  return diffs.filter((path) => path !== "spec.claim.released" && !path.startsWith("spec.claim.released."));
}

/** Recursive JSON-value diff; records the dot-path of each unequal leaf. */
function diffValue(path: string, a: unknown, b: unknown, diffs: string[]): void {
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(path === "" ? key : `${path}.${key}`, a[key], b[key], diffs);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push(path);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      diffValue(`${path}[${i}]`, a[i], b[i], diffs);
    }
    return;
  }
  if (!jsonScalarEquals(a, b)) diffs.push(path);
}

/** Scalar/array-element equality; arrays of arrays recur element-wise. */
function jsonScalarEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => jsonScalarEquals(value, b[i]));
  }
  return a === b;
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
