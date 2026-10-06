// Status surface (core §8): providers report ready/provisionable/progress/
// asOf into the cache; the registry forwards those fields and derives
// `claimedBy` from Claim documents (core §8.4/§9) — the cache can never
// inject or erase a claim.
//
// §8.4 keying: a claim's occupancy identity is `claimedOn {fingerprint,
// durable_id}`. Storage-backed kinds (Workspace) key claimedBy on
// `fingerprint` — every document sharing the fingerprint sees every claim
// occupying the storage, regardless of which parent/child view either side
// resolved through (the RWO-advisory cross-view case). Non-storage-backed
// kinds key on `durable_id` (per-object exclusivity by definition). Only
// un-released claims derive; the claim set is latest-per-name from the
// store's merged snapshot, so a release takes effect the moment its
// overlay line lands.
//
// The cache is keyed `Kind/name` and holds the provider-reported fields.
// Never-observed documents take the kind spec's declared default; for
// Workspace (the only kind with a runner in T1) that is
// `ready: false, provisionable: true` — a registered workspace is
// presumed lazily materializable until the provider says otherwise.

import { durableIdOf, isRecord, type FabricDocument } from "./document.js";
import { documentKey } from "./lineage.js";

/**
 * One claim on a status surface (core §9): the Claim's metadata.name,
 * spec.owner, spec.claim.principal, and spec.claim.claimedOn verbatim.
 * Adapters identify their own claims by `principal`.
 */
export type ClaimedRef = {
  name: string;
  owner: string;
  principal: string;
  claimedOn: { fingerprint?: string; durable_id: string };
};

export type StatusSurface = {
  ready: boolean;
  provisionable: boolean;
  claimedBy: ClaimedRef[];
  progress: string;
  asOf: string | null;
  source: "live" | "cached";
};

export type StatusCache = Map<string, StatusSurface>;

/** Selectability (core §7): `st.ready OR st.provisionable`. */
export function selectable(st: StatusSurface): boolean {
  return st.ready || st.provisionable;
}

/** The Workspace never-observed default (core §8 / Global Constraints). */
export const neverObservedDefault: StatusSurface = {
  ready: false,
  provisionable: true,
  claimedBy: [],
  progress: "no provider report yet",
  asOf: null,
  source: "cached",
};

/**
 * The §8.4 derivation: all un-released Claims in `claims` (the merged
 * document set's latest-per-name view — store.current() filtered to
 * kind Claim) whose claimedOn key matches `doc`. Fingerprint equality for
 * storage-backed kinds (Workspace), durable_id equality otherwise.
 *
 * Read-time derivation: no claim state is cached, so a claim append or
 * release is visible on the very next statusFor call. Orphan claims
 * (parent deleted) still derive — claimedOn is self-contained.
 */
export function deriveClaimedBy(doc: FabricDocument, claims: readonly FabricDocument[]): ClaimedRef[] {
  const refs: ClaimedRef[] = [];
  for (const claim of claims) {
    if (claim.kind !== "Claim") continue;
    const claimedOn = claim.kindSpec["claimedOn"];
    if (!isRecord(claimedOn)) continue;
    if (claim.kindSpec["released"] === true) continue;
    const claimFingerprint = claimedOn["fingerprint"];
    const claimDurableId = claimedOn["durable_id"];
    if (doc.kind === "Workspace") {
      // Storage-backed: key on the fingerprint — every document sharing
      // the storage sees every claim occupying it (§8.4).
      if (typeof claimFingerprint !== "string" || claimFingerprint === "") continue;
      const storage = doc.kindSpec["storage"];
      const docFingerprint = isRecord(storage) ? storage["fingerprint"] : undefined;
      if (docFingerprint !== claimFingerprint) continue;
    } else {
      // Non-storage-backed: key on the durable id (per-object exclusivity).
      if (claimDurableId !== durableIdOf(doc)) continue;
    }
    const principal = claim.kindSpec["principal"];
    refs.push({
      name: claim.name,
      owner: claim.owner,
      principal: typeof principal === "string" ? principal : "",
      claimedOn: {
        ...(typeof claimFingerprint === "string" && claimFingerprint !== ""
          ? { fingerprint: claimFingerprint }
          : {}),
        durable_id: typeof claimDurableId === "string" ? claimDurableId : "",
      },
    });
  }
  return refs;
}

/**
 * The served status surface: the cached provider report's fields (or the
 * never-observed default) with `claimedBy` derived from `claims` — never
 * taken from the cache (a report's claimedBy is ignored at the door; a
 * stale cache entry cannot inject one either).
 */
export function statusFor(
  doc: FabricDocument,
  cache: StatusCache,
  claims: readonly FabricDocument[],
): StatusSurface {
  const base = cache.get(documentKey(doc)) ?? neverObservedDefault;
  return { ...base, claimedBy: deriveClaimedBy(doc, claims) };
}
