// HTTP routing (workspace §8's surface) — a small method + path table
// over node:http, kept separate from the resolver and the store: this file
// owns request parsing and response serialization only; behavior comes
// from RegistryStore (Task 5) and resolve (Task 4).
//
// All routes live under /twill/v1alpha1. Kinds are capitalized in URLs
// (`/twill/v1alpha1/Workspace/<name>`). Unknown paths → 404.

import type { IncomingMessage, ServerResponse } from "node:http";
import { KINDS, durableIdOf, isRecord, type FabricDocument, type Kind } from "./document.js";
import { resolve, type Consumer } from "./resolver.js";
import { documentKey } from "./lineage.js";
import { validateClaimCreate, validateClaimRelease } from "./claims.js";
import type { RegistryStore } from "./store.js";
import { neverObservedDefault, type StatusCache, type StatusSurface } from "./status.js";

/** An error response: the HTTP status plus the `error` body field. */
export type RouteError = { httpStatus: 400 | 404; error: string };

export type HttpStatus =
  | 200 // success (incl. claim release + idempotent re-release, T2a)
  | 201 // claim created (T2a)
  | 400 // malformed body / missing or ill-typed fields (incl. GET /claims without `parent`)
  | 404 // unknown path or absent document (PATCH on a missing claim, T2a; POST /claims plural)
  | 409 // claim conflicts: existing Claim name, missing parent, PATCH mutating beyond release (T2a)
  | 422 // claimedOn inconsistent with the parent document (T2a, §8.4)
  | 500 // internal fault (e.g. the overlay write failing — readJsonBody's last-resort guard)
  | 501; // T1-deferred surface (GET /Claim/<name>; the overlay PATCH)

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
 * Dispatch one request against `store`. `req.url` carries the query string;
 * the path alone drives dispatch, and the one query-parameter surface —
 * GET /claims?parent=<kind>/<name>&includeReleased=<bool> (T2a Task 5) —
 * parses its parameters from the URL. Never throws itself; body-handling
 * failures are answered as JSON by readJsonBody's last-resort 500 guard
 * (server.ts's try/catch cannot contain async body callbacks).
 */
export function route(store: RegistryStore, req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = qIndex === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qIndex + 1));
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

  // GET /claims?parent=<kind>/<name> (T2a Task 5): the provider read-path —
  // every claim against the parent, un-released only by default. The T1 501
  // is removed; POST /claims (plural) was never a real endpoint (creates go
  // to POST /Claim/<name>) and falls through to 404 like any unknown path.
  if (first === "claims" && segments.length === 1) {
    if (method === "GET") {
      const checked = claimsQuery(store, query);
      if ("error" in checked) {
        respond(res, checked.httpStatus, { error: checked.error });
        return;
      }
      respond(res, 200, checked.claims);
      return;
    }
    respond(res, 404, { error: `unknown path: ${path}` });
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
  // /Claim/<name>: POST creates the claim, PATCH releases it (T2a Tasks
  // 1+2 — release is the only permitted mutation, workspace §8). GET stays
  // T1-deferred (single-claim GET is not part of v1alpha1's surface). Any
  // other method falls through to the generic method-not-supported 404
  // below.
  if (first === "Claim" && second !== undefined && third === undefined) {
    if (method === "POST") {
      readJsonBody(req, res, (body) => {
        const checked = validateClaimCreate(body, second, store);
        if (!checked.ok) {
          respond(res, checked.status, { error: checked.error });
          return;
        }
        const appended = store.appendOverlay(checked.doc);
        if (!appended.ok) {
          // Write-time merged-set validation (workspace §8): the write whose
          // merged result would violate §8.3 is refused, never persisted.
          respond(res, 409, { error: appended.error ?? "merged document set rejected" });
          return;
        }
        respond(res, 201, checked.doc.raw);
      });
      return;
    }
    if (method === "PATCH") {
      readJsonBody(req, res, (body) => {
        const checked = validateClaimRelease(second, body, store);
        if (!checked.ok) {
          respond(res, checked.status, { error: checked.error });
          return;
        }
        // Idempotent no-op (re-release of an already-released claim): serve
        // the stored claim without appending to the overlay.
        if (store.get("Claim", second) === checked.doc) {
          respond(res, 200, checked.doc.raw);
          return;
        }
        const appended = store.appendOverlay(checked.doc);
        if (!appended.ok) {
          // Same write-time merged-set validation as create.
          respond(res, 409, { error: appended.error ?? "merged document set rejected" });
          return;
        }
        respond(res, 200, checked.doc.raw);
      });
      return;
    }
    if (method === "GET") {
      respond(res, 501, CLAIMS_UNIMPLEMENTED);
      return;
    }
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
    // Last-resort guard for handler faults — this callback runs after
    // route() returned, so server.ts's try/catch cannot contain a throw
    // here and no process-level uncaughtException handler exists (the
    // overlay write fault — ENOSPC/EACCES/EROFS on append — was the
    // review-P1 crash). Answer 500 JSON and keep the process alive; the
    // store is untouched (appendOverlay validates and persists before any
    // in-memory change).
    try {
      then(body);
    } catch (err) {
      respond(res, 500, { error: `internal error: ${String(err)}` });
    }
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

/**
 * The provider claims read-path (workspace §8): every claim document whose
 * `spec.parent` matches the kind-qualified `parent` query parameter,
 * un-released only unless `includeReleased=true`. The parameter is
 * required — a bare GET /claims is a 400 naming it. A parent that never
 * existed (or is currently orphan-deleted) is not an error: providers poll
 * for parents that may not be registered yet, so the answer is 200 with an
 * empty array. Claim envelopes are served verbatim from `doc.raw`, with
 * `status.inert` stamped true on orphan claims (parent unresolvable) —
 * the inert marking is derived store-side and stamps only status, which
 * readers ignore.
 */
function claimsQuery(
  store: RegistryStore,
  query: URLSearchParams,
): { claims: Array<Record<string, unknown>> } | RouteError {
  const parent = query.get("parent");
  if (parent === null || parent === "") {
    return {
      httpStatus: 400,
      error: "the 'parent' query parameter is required (GET /claims?parent=<kind>/<name>)",
    };
  }
  const includeReleased = query.get("includeReleased") === "true";
  const claims: Array<Record<string, unknown>> = [];
  for (const doc of store.claims()) {
    if (doc.parent === undefined || `${doc.parent.kind}/${doc.parent.name}` !== parent) continue;
    if (!includeReleased && doc.kindSpec["released"] === true) continue;
    const raw = isRecord(doc.raw) ? { ...doc.raw } : {};
    const status = isRecord(raw["status"]) ? { ...raw["status"] } : {};
    if (!doc.resolvable) status["inert"] = true;
    raw["status"] = status;
    claims.push(raw);
  }
  return { claims };
}
