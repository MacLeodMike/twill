// HTTP routing (workspace §8's surface) — a small method + path table
// over node:http, kept separate from the resolver and the store: this file
// owns request parsing and response serialization only; behavior comes
// from RegistryStore (Task 5) and resolve (Task 4).
//
// All routes live under /twill/v1alpha1. Kinds are capitalized in URLs
// (`/twill/v1alpha1/Workspace/<name>`). Unknown paths → 404. Claims
// create/read and the writable overlay are T1-deferred and answer 501
// with an explicit error body (Global Constraints / workspace §8).

import type { IncomingMessage, ServerResponse } from "node:http";
import { KINDS, durableIdOf, isRecord, type FabricDocument, type Kind } from "./document.js";
import { resolve, type Consumer } from "./resolver.js";
import { documentKey } from "./lineage.js";
import type { RegistryStore } from "./store.js";
import { neverObservedDefault, type StatusCache, type StatusSurface } from "./status.js";

/** An error response: the HTTP status plus the `error` body field. */
export type RouteError = { httpStatus: 400 | 404; error: string };

export type HttpStatus =
  | 200 // success
  | 400 // malformed body / missing or ill-typed fields
  | 404 // unknown path or absent document
  | 501; // T1-deferred surface (claims, overlay)

/** The T1-deferred bodies (Global Constraints + workspace §8). */
export const CLAIMS_UNIMPLEMENTED = {
  error: "claims unimplemented in T1 milestone",
  milestone: "T2",
} as const;
export const OVERLAY_UNIMPLEMENTED = {
  error: "overlay writes unimplemented in T1 milestone",
} as const;

/** The `/twill/v1alpha1` prefix every route lives under (workspace §8). */
export const API_PREFIX = "/twill/v1alpha1";

/**
 * Dispatch one request against `store`. `req.url` is the request path
 * (query string ignored — T1 has no query-parameter surface that works:
 * `/claims` is 501 and the rest is queryless). Never throws; every
 * failure path is a JSON response.
 */
export function route(store: RegistryStore, req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const method = req.method ?? "GET";

  if (!path.startsWith(`${API_PREFIX}/`) && path !== API_PREFIX) {
    respond(res, 404, { error: `unknown path: ${path} (expected ${API_PREFIX}/...)` });
    return;
  }
  const rest = path === API_PREFIX ? "" : path.slice(API_PREFIX.length + 1);
  const segments = rest.split("/").filter((s) => s !== "");

  // GET /twill/v1alpha1 — discovery (core §10.3 shape, inert included).
  if (segments.length === 0) {
    if (method === "GET") {
      respond(res, 200, discovery(store));
    } else {
      respond(res, 404, { error: `method ${method} not supported on ${API_PREFIX}` });
    }
    return;
  }

  const [first, second, third] = segments as [string, string | undefined, string | undefined];

  // 501 surface first: the claims trio and overlay PATCH are T1-deferred
  // regardless of what the rest of the path says.
  if (first === "claims" && segments.length === 1 && (method === "GET" || method === "POST")) {
    respond(res, 501, CLAIMS_UNIMPLEMENTED);
    return;
  }
  if (first === "resolve" && segments.length === 1 && method === "POST") {
    readJsonBody(req, res, (body) => {
      const checked = resolveBody(body);
      if ("error" in checked) {
        respond(res, checked.httpStatus, { error: checked.error });
        return;
      }
      respond(res, 200, resolve(checked.kind, checked.name, checked.consumer, store));
    });
    return;
  }
  if (first === "health" && segments.length === 1 && method === "GET") {
    respond(res, 200, store.health());
    return;
  }
  // /Claim/<name>: the claim surface is T1-deferred for every method —
  // no Claim document can exist in T1 (creation is 501), so a GET here
  // can never legitimately succeed; 501 is the truthful answer.
  if (first === "Claim" && second !== undefined && third === undefined) {
    respond(res, 501, CLAIMS_UNIMPLEMENTED);
    return;
  }
  // Unknown top-level segment: only kinds may appear there. Reserved
  // words (resolve/health/claims) arriving here used a wrong method/shape;
  // anything else is simply not a kind.
  const reserved = first === "resolve" || first === "health" || first === "claims";
  if (reserved || !KINDS.includes(first as Kind)) {
    respond(
      res,
      404,
      reserved
        ? { error: `unknown path: ${path}` }
        : { error: `unknown kind: ${first} (path: ${path})` },
    );
    return;
  }

  const kind = first as Kind;

  // /<Kind>/<name> — GET the document, PATCH the (deferred) overlay.
  if (second !== undefined && third === undefined) {
    if (method === "GET") {
      const doc = store.get(kind, second);
      if (doc === undefined) {
        respond(res, 404, { error: `no such document: ${kind}/${second}` });
        return;
      }
      // Pin 5: serve doc.raw — the verbatim parsed YAML envelope, not the
      // FabricDocument projection.
      respond(res, 200, doc.raw);
      return;
    }
    if (method === "PATCH") {
      respond(res, 501, OVERLAY_UNIMPLEMENTED);
      return;
    }
    respond(res, 404, { error: `method ${method} not supported on /<kind>/<name>` });
    return;
  }

  // /<Kind>/<name>/statusReport — the provider push (core §8).
  if (second !== undefined && third === "statusReport" && segments.length === 3 && method === "POST") {
    readJsonBody(req, res, (body) => {
      const merged = statusReport(store, kind, second, body);
      if ("error" in merged) {
        respond(res, merged.httpStatus, { error: merged.error });
        return;
      }
      respond(res, 200, merged.surface);
    });
    return;
  }

  respond(res, 404, { error: `unknown path: ${path}` });
}

/**
 * Discovery (core §10.3): one row per document in the current snapshot,
 * inert included. The ledger ruling on `resolvable`: the document field
 * alone does NOT capture §10.3's conjunct — compose it here as
 * `doc.resolvable && doc.routes.length > 0`.
 */
function discovery(store: RegistryStore): Array<Record<string, unknown>> {
  return store.current().documents.map((doc) => {
    const row: Record<string, unknown> = {
      kind: doc.kind,
      name: doc.name,
      durable_id: durableIdOf(doc),
      resolvable: doc.resolvable && doc.routes.length > 0,
    };
    if (doc.parent !== undefined) row.parent = { kind: doc.parent.kind, name: doc.parent.name };
    return row;
  });
}

/** The `/resolve` body: `{kind, name, consumer}` — all required, typed. */
function resolveBody(
  body: unknown,
): { kind: Kind; name: string; consumer: Consumer } | RouteError {
  if (!isRecord(body)) return { httpStatus: 400, error: "resolve body must be a JSON object" };
  const kind = body["kind"];
  const name = body["name"];
  const consumer = body["consumer"];
  if (typeof kind !== "string" || kind === "")
    return { httpStatus: 400, error: "resolve body: kind (string) is required" };
  if (!KINDS.includes(kind as Kind)) return { httpStatus: 400, error: `unknown kind: ${kind}` };
  if (typeof name !== "string" || name === "")
    return { httpStatus: 400, error: "resolve body: name (string) is required" };
  if (!isRecord(consumer))
    return {
      httpStatus: 400,
      error: "resolve body: consumer {agentLocation, agentKind, principal} is required",
    };
  const agentLocation = consumer["agentLocation"];
  const agentKind = consumer["agentKind"];
  const principal = consumer["principal"];
  if (typeof agentLocation !== "string" || typeof agentKind !== "string" || typeof principal !== "string") {
    return {
      httpStatus: 400,
      error: "resolve body: consumer requires string agentLocation, agentKind, principal (all three, possibly empty)",
    };
  }
  return { kind: kind as Kind, name, consumer: { agentLocation, agentKind, principal } };
}

/**
 * Provider status report (core §8): merge `{ready?, provisionable?,
 * progress?, asOf?}` field-wise onto any existing cache entry — a report
 * carrying only `{progress}` must not wipe a prior `ready`. `claimedBy` is
 * registry-derived (Claim documents, T2): a submitted value is ignored
 * with a warning log. Missing `asOf` → now (RFC 3339). 404 when the
 * document is absent from the current snapshot — the cache is untouched.
 */
function statusReport(
  store: RegistryStore,
  kind: Kind,
  name: string,
  body: unknown,
): RouteError | { surface: StatusSurface } {
  const doc = store.get(kind, name);
  if (doc === undefined) return { httpStatus: 404, error: `no such document: ${kind}/${name}` };
  if (!isRecord(body)) return { httpStatus: 400, error: "statusReport body must be a JSON object" };

  if ("claimedBy" in body) {
    // eslint-disable-next-line no-console
    console.warn(
      `[twill] statusReport for ${kind}/${name} carried claimedBy — ignored (claimedBy is derived from Claim documents, never reported)`,
    );
  }

  const checked = reportFields(body);
  if (checked !== undefined) return { httpStatus: 400, error: checked };

  return { surface: mergeReport(store.statusCache, doc, body) };
}

/** Type-check the reportable fields; a message naming the first offender. */
function reportFields(body: Record<string, unknown>): string | undefined {
  const ready = body["ready"];
  const provisionable = body["provisionable"];
  const progress = body["progress"];
  const asOf = body["asOf"];
  if (ready !== undefined && typeof ready !== "boolean") return "statusReport field ready must be a boolean";
  if (provisionable !== undefined && typeof provisionable !== "boolean")
    return "statusReport field provisionable must be a boolean";
  if (progress !== undefined && typeof progress !== "string") return "statusReport field progress must be a string";
  if (asOf !== undefined && (typeof asOf !== "string" || Number.isNaN(new Date(asOf).getTime())))
    return "statusReport field asOf must be an RFC 3339 timestamp string";
  return undefined;
}

/** Field-wise merge onto the current entry (or the never-observed default). */
function mergeReport(cache: StatusCache, doc: FabricDocument, body: Record<string, unknown>): StatusSurface {
  const key = documentKey(doc);
  const prior: StatusSurface = cache.get(key) ?? neverObservedDefault;
  const entry: StatusSurface = {
    ready: typeof body["ready"] === "boolean" ? body["ready"] : prior.ready,
    provisionable: typeof body["provisionable"] === "boolean" ? body["provisionable"] : prior.provisionable,
    // Registry-derived (Claim documents, T2): carried from the prior entry,
    // never taken from the report; copied so the default's array is never
    // aliased into a cache entry.
    claimedBy: [...prior.claimedBy],
    progress: typeof body["progress"] === "string" ? body["progress"] : prior.progress,
    asOf: typeof body["asOf"] === "string" ? body["asOf"] : new Date().toISOString(),
    source: "live",
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Read the request body as UTF-8 and JSON.parse it. Malformed JSON → 400
 * `{"error": ...}`; the callback only runs on well-formed JSON (an empty
 * body is malformed — every POST surface here requires a body).
 */
function readJsonBody(req: IncomingMessage, res: ServerResponse, then: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      respond(res, 400, { error: `malformed JSON body: ${String(err)}` });
      return;
    }
    then(body);
  });
  req.on("error", () => {
    respond(res, 400, { error: "request body read failed" });
  });
}

/** Serialize and end the response. Never throws to the http layer. */
function respond(res: ServerResponse, status: HttpStatus, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}