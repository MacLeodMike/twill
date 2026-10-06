// Resolver (core §7) — the registry-side selection algorithm, transcribed:
//
//   resolve(kind, name, consumer) -> Attached | NoMatch | Unreachable:
//     obj    <- registry.get(kind, name)
//     if obj is missing: return NoMatch(kind, name, consumer)
//     routes <- obj.spec.routes.filter(matches(r.match, consumer))
//     if routes is empty: return NoMatch(obj, consumer)
//     errors <- []
//     for r in routes (in declared order):
//       if r.type not in kind spec's enum: errors.append((r, "unknown route type")); continue
//       st  <- registry.statusFor(obj, r)
//       if not st.selectable: errors.append((r, "not selectable")); continue
//       return Attached(routeDescriptor(obj, r, st))
//     return Unreachable(obj, consumer, errors)
//
// Pins: order before readiness (a lower route is selected only if every
// earlier matching route was rejected); non-matching routes are silently
// skipped and never generate errors; the returned route is a verbatim
// copy of the stored document's route object (no injected fields).

import { durableIdOf, type FabricDocument, type Kind, type Route } from "./document.js";
import { matches, type Consumer } from "./matching.js";

export type { Consumer };

import { selectable, statusFor, type StatusCache, type StatusSurface } from "./status.js";

/** Minimal structural store the resolver needs (Task 5's RegistryStore satisfies it). */
export interface ResolveStore {
  get(kind: Kind, name: string): FabricDocument | undefined;
  statusCache: StatusCache;
}

/** Workspace route-type enum (workspace spec §4) — T1's registered kind. */
const WORKSPACE_ROUTE_TYPES: ReadonlySet<string> = new Set(["local", "ssh", "k8s-exec"]);

export type RouteError = { route: Route; reason: string };

export type AttachedDescriptor = {
  kind: Kind;
  name: string;
  durable_id: string | null;
  route: Route;
  status: StatusSurface;
};

export type ResolveResult =
  | { result: "Attached"; descriptor: AttachedDescriptor }
  | { result: "NoMatch" }
  | { result: "Unreachable"; errors: RouteError[] };

export function resolve(kind: Kind, name: string, consumer: Consumer, store: ResolveStore): ResolveResult {
  const doc = store.get(kind, name);
  if (doc === undefined) return { result: "NoMatch" };

  const routes = doc.routes.filter((route) => matches(route["match"], consumer));
  if (routes.length === 0) return { result: "NoMatch" };

  const errors: RouteError[] = [];
  for (const route of routes) {
    if (!routeTypeAllowed(kind, route["type"])) {
      errors.push({ route, reason: `unknown route type: ${String(route["type"])}` });
      continue;
    }
    const st = statusFor(doc, store.statusCache);
    if (!selectable(st)) {
      errors.push({ route, reason: "not selectable: status reports neither ready nor provisionable" });
      continue;
    }
    return {
      result: "Attached",
      descriptor: {
        kind: doc.kind,
        name: doc.name,
        durable_id: durableIdOf(doc),
        route,
        status: st,
      },
    };
  }
  return { result: "Unreachable", errors };
}

function routeTypeAllowed(kind: Kind, type: string): boolean {
  return kind === "Workspace" ? WORKSPACE_ROUTE_TYPES.has(type) : true;
}
