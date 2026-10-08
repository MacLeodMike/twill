// Claim-route matching (T2.5 Task 3) — the provider's binding rule
// (provider spec §4): a claim is THIS provider's iff its verbatim
// `spec.claim.route` deep-equals one of the provider's configured routes.
// The registry returns every claim against a parent; the provider filters
// client-side. Exact deep equality — no subset, no key-order sensitivity,
// no wildcard — because the route copy is the binding: two providers
// backing one fingerprint never both materialize, since each owns a
// *distinct route object*.

import type { Route } from "../registry/document.js";

/**
 * True when `claimRoute` deep-equals some route in `mine`. Routes are JSON
 * values (objects with the protocol-fixed `type`/`match` keys plus
 * kind-owned static fields); deep equality is order-insensitive on object
 * keys and order-sensitive on arrays, matching JSON semantics.
 */
export function isMine(claimRoute: Route, mine: Route[]): boolean {
  return mine.some((route) => routeDeepEqual(claimRoute, route));
}

/** Structural JSON equality: scalars by ===; arrays element-wise; records key-set + per-key. */
function routeDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => routeDeepEqual(value, b[i]));
  }
  if (isRouteObject(a) && isRouteObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && routeDeepEqual(a[key], b[key]));
  }
  return false;
}

function isRouteObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
