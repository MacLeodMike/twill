// Status surface (core §8): providers report; the registry forwards.
// The cache is keyed `Kind/name` and holds the six-field protocol shape.
// Never-observed documents take the kind spec's declared default; for
// Workspace (the only kind with a runner in T1) that is
// `ready: false, provisionable: true` — a registered workspace is
// presumed lazily materializable until the provider says otherwise.
//
// `claimedBy` is always `[]` in T1 (Claim document derivation lands in a
// later task) and is never defaulted from a provider report.

import type { FabricDocument } from "./document.js";
import { documentKey } from "./lineage.js";

export type ClaimedRef = { name: string; owner: string; principal: string; claimedOn: string };

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

/** Cached provider report if present, else the never-observed default. */
export function statusFor(doc: FabricDocument, cache: StatusCache): StatusSurface {
  return cache.get(documentKey(doc)) ?? neverObservedDefault;
}
