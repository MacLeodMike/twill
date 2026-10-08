// The provider loop (T2.5 Task 3) — the fabric's third party: poll the
// registry for claims against the workspaces this provider owns, fulfill
// the ones whose route it owns, report status back. The provider talks to
// the registry ONLY over HTTP (provider spec §3 — "the exact bytes any
// third-party provider would exchange"; the store is never imported).
//
// The loop (provider spec §5, workspace §6 step 4), per poll, per parent:
//   GET <registry>/claims?parent=Workspace/<p>&includeReleased=false
//   → filter to claims whose spec.claim.route deep-equals a configured
//     route (match.ts — Review Focus #1: route-mismatched claims are
//     IGNORED: no materialization, no statusReport)
//   → fulfill serially per parent (an in-process promise-chain queue per
//     parent; two different parents MAY run concurrently, one parent never
//     races itself — provider spec §6).
//
// Fulfillment (provider spec §5):
//   worktree claim (claim carries spec.claim.parameters.worktreeName):
//     1. parent statusReport {ready:false, progress:"provisioning <name>"}
//     2. run the claim route's precondition.steps[] (runPrecondition
//        substitutes {{claim.parameters.*}})
//     3. on success: build the child document (§5.3 deterministic rules),
//        PATCH /Workspace/<child> (the t25-1 upsert), child statusReport
//        {ready:true}, final parent statusReport restoring the parent's
//        own pre-fulfillment state
//   cold-root claim (no worktreeName — Review Focus #5): run the PARENT's
//     preconditions, report {ready:true} on the parent, NO child.
//   failure: parent statusReport {ready:false, progress:"<why>"}, no child.
//
// Idempotence (spec §6): a claim whose child already exists AND is ready
// is skipped (no re-materialization); re-running a precondition step is a
// no-op (preconditions.ts); the deterministic child name makes a duplicate
// claim converge (upsert), never diverge.
//
// Placement root: the claim route's own `path` (the verbatim parent route —
// workspace §6.2: claims name the resolved route verbatim). Materialized
// clones/worktrees live at <route.path>/.twill/<parent-name>/…, derived
// from the parent workspace itself. Only a `type: "local"` route may be a
// local claim target: a misconfigured non-local route (e.g. `ssh`) that
// carries a `path` fails loud with progress naming the route type (T25-3
// review) — never materialized locally at the remote path; a route without
// a string `path` fails with progress naming the missing path.
//
// Placement-path sanitization (T25-2 review, carried into Task 3): the
// worktreeName is validated before ANY materialization or status write —
// it must be a single path segment (no `/`, no `..`); a claim with an
// unsafe worktreeName is rejected with a statusReport progress naming the
// invalid parameter.

import { homedir } from "node:os";
import { type Route } from "../registry/document.js";

// The provider's public surface (the `./provider` export) references Route in
// ProviderConfig.routes, so re-export it — one spelling of the wire type,
// owned here, so consumers never re-declare the protocol type locally.
export type { Route } from "../registry/document.js";
import { buildChildDocument, childNameFor, type ClaimEnvelope } from "./child.js";
import { isMine } from "./match.js";
import { runPrecondition, type PreconditionStep } from "./preconditions.js";

/** A resolve consumer (the registry's Consumer wire shape, re-declared: the
 *  provider never imports registry internals — only wire types). */
type ResolveConsumer = { agentLocation: string; agentKind: string; principal: string };

/**
 * Provider configuration. `routes` are the verbatim route objects this
 * provider owns (a claim is this provider's iff spec.claim.route
 * deep-equals one of them); `parents` are the parent workspace names it
 * polls; `registry` is the registry base URL (with or without the
 * /twill/v1alpha1 prefix). `pollIntervalMs` defaults to 5000.
 */
export interface ProviderConfig {
  registry: string;
  routes: Route[];
  parents: string[];
  pollIntervalMs?: number;
  /**
   * Optional lifecycle observer: called once per poll-observed event
   * (claim fulfilled, fulfillment failed, claim ignored, claim skipped as
   * already fulfilled) with a single self-describing line. The CLI wires
   * console.log ("logs fulfillments to stdout", spec §2); twill-pi routes
   * it into pi's own logging. Lines carry a leading ISO timestamp, stamped
   * here once so embedders need no timestamp logic.
   */
  onEvent?: (line: string) => void;
}

/** The embeddable handle: stop() halts polling; in-flight fulfillments settle. */
export interface ProviderHandle {
  stop(): void;
}

type StatusReportBody = { ready?: boolean; provisionable?: boolean; progress?: string };

/** One lifecycle event (Task 5): the loop stamps exactly {event, at} — a
 *  future event extends the payload without a signature change. */
type ProviderEvent = { event: string; at: string };

/** The one-line lifecycle rendering shared by every event. */
function renderEvent(e: ProviderEvent): string {
  return `${e.at} ${e.event}`;
}

/** Normalize the registry base: ensure it ends with the API prefix. */
function registryBase(registry: string): string {
  const trimmed = registry.replace(/\/+$/, "");
  return trimmed.endsWith("/twill/v1alpha1") ? trimmed : `${trimmed}/twill/v1alpha1`;
}

/** Expand a leading `~/` against the process home (workspace §6 routes carry `~` paths). */
function expandPath(path: string): string {
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/**
 * Placement-path sanitization (T25-2 review ruling): a value joined into a
 * materialization path must be a single segment — no `/`, no `..`. Returns
 * the violation reason naming the parameter, or undefined when safe.
 */
function unsafePathSegment(value: string): string | undefined {
  if (value === "" || value.includes("/") || value.includes("..")) {
    return `worktreeName ${JSON.stringify(value)} is not a safe path segment (must not contain '/' or '..')`;
  }
  return undefined;
}

/** Build the resolve consumer that a route's own match always satisfies:
 *  copy the match's known consumer keys (missing → ""). */
function consumerFromMatch(route: Route): ResolveConsumer {
  const raw = route["match"];
  const m = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    agentLocation: typeof m["agentLocation"] === "string" ? m["agentLocation"] : "",
    agentKind: typeof m["agentKind"] === "string" ? m["agentKind"] : "",
    principal: typeof m["principal"] === "string" ? m["principal"] : "",
  };
}

/** Extract the claim envelope's parameters as a string map. */
function claimParameters(claim: ClaimEnvelope): Record<string, string> {
  const raw = claim.spec?.claim?.parameters;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** The claim's route as a Route record, or undefined when absent/non-object. */
function claimRoute(claim: ClaimEnvelope): Route | undefined {
  const route = claim.spec?.claim?.route;
  if (typeof route !== "object" || route === null || Array.isArray(route)) return undefined;
  return route as Route;
}

/**
 * The materialization root for claims against `parentName` served by
 * `route`: <route.path>/.twill/<parentName>. The local-route guard (T25-3
 * review): only `type: "local"` may be materialized locally — a
 * misconfigured non-local route (e.g. `ssh`) carrying a `path` fails loud
 * with a reason naming the route type, never materializes at the remote
 * path. A route without a string `path` fails naming the missing path.
 */
function workDirFor(
  route: Route,
  parentName: string,
): { ok: true; workDir: string } | { ok: false; reason: string } {
  const type = route["type"];
  if (type !== "local") {
    return {
      ok: false,
      reason: `claim route type ${JSON.stringify(type)} is not local — refusing to materialize it at a local path`,
    };
  }
  const raw = route["path"];
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, reason: `claim route has no local path to materialize into` };
  }
  return { ok: true, workDir: `${expandPath(raw).replace(/\/+$/, "")}/.twill/${parentName}` };
}

/** The precondition steps of a route (workspace §7's `precondition.steps[]`). */
function preconditionSteps(route: Route): PreconditionStep[] {
  const precondition = route["precondition"];
  if (typeof precondition !== "object" || precondition === null || Array.isArray(precondition)) return [];
  const steps = (precondition as Record<string, unknown>)["steps"];
  if (!Array.isArray(steps)) return [];
  return steps.filter(
    (step): step is PreconditionStep =>
      typeof step === "object" && step !== null && !Array.isArray(step) && typeof (step as Record<string, unknown>)["type"] === "string",
  );
}

/** Run a route's precondition steps in order; the first failure aborts. */
async function runSteps(
  steps: PreconditionStep[],
  ctx: { claimParameters: Record<string, string>; workDir: string },
): Promise<{ ok: true; path?: string } | { ok: false; error: string }> {
  let lastPath: string | undefined;
  for (const step of steps) {
    const result = await runPrecondition(step, ctx);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.path !== undefined) lastPath = result.path;
  }
  return lastPath === undefined ? { ok: true } : { ok: true, path: lastPath };
}

/**
 * Start the provider loop. Returns immediately; polling runs on the
 * configured interval. `stop()` ends polling and lets in-flight
 * fulfillments settle.
 */
export function startProvider(config: ProviderConfig): ProviderHandle {
  const base = registryBase(config.registry);
  const pollIntervalMs = config.pollIntervalMs ?? 5000;
  // Per-parent serial queues (spec §6): a promise chain per parent —
  // enqueued fulfillments run one at a time per parent; distinct parents
  // run concurrently.
  const parentTails = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let polling = false;

  /** Emit one lifecycle line (no sink configured = the embedder observes nothing). */
  function emit(event: string): void {
    config.onEvent?.(renderEvent({ event, at: new Date().toISOString() }));
  }

  /** The claim's own name, for log lines. */
  function claimNameOf(claim: ClaimEnvelope): string {
    return claim.metadata?.name ?? "(unnamed claim)";
  }

  async function report(kind: string, name: string, body: StatusReportBody): Promise<void> {
    await fetch(`${base}/${kind}/${name}/statusReport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<unknown> {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return undefined;
    return res.json();
  }

  async function patchDocument(kind: string, name: string, doc: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/${kind}/${name}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
  }

  /** The parent's own state (ready/progress) read over HTTP via resolve.
   *  The statusReport cache has no GET of its own — resolve is the only
   *  status read surface. The consumer is derived from the claim route's
   *  match (which the parent shares: a claim's route is a verbatim copy of
   *  the parent route it resolved), so it always matches a parent route. */
  async function parentStatus(parentName: string, consumer: ResolveConsumer): Promise<{ ready?: boolean; progress?: string }> {
    const st = await resolveStatus(parentName, consumer);
    return st === undefined ? {} : { ready: st.ready, progress: st.progress };
  }

  /** True when the claim's child already exists AND is ready (idempotent skip). */
  async function childReady(childName: string, consumer: ResolveConsumer): Promise<boolean> {
    const st = await resolveStatus(childName, consumer);
    return st?.ready === true;
  }

  /** POST /resolve and read the Attached descriptor's status surface, or
   *  undefined on NoMatch/Unreachable/non-200 (the provider treats an
   *  unresolvable target as "no status yet"). */
  async function resolveStatus(
    name: string,
    consumer: ResolveConsumer,
  ): Promise<{ ready: boolean; progress: string } | undefined> {
    const res = await fetch(`${base}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "Workspace", name, consumer }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      result?: string;
      descriptor?: { status?: { ready?: unknown; progress?: unknown } };
    };
    if (body.result !== "Attached") return undefined;
    const status = body.descriptor?.status;
    if (typeof status !== "object" || status === null) return undefined;
    return {
      ready: status.ready === true,
      progress: typeof status.progress === "string" ? status.progress : "",
    };
  }

  /** Fulfill one claim (already route-matched). Runs on the parent's serial queue. */
  async function fulfill(parentName: string, claim: ClaimEnvelope): Promise<void> {
    const route = claimRoute(claim);
    if (route === undefined) return;
    const parameters = claimParameters(claim);
    const worktreeName = parameters["worktreeName"];
    // The consumer that resolves the claim's own route: built from the
    // route's match, so it satisfies that match exactly (workspace §6's
    // claim.route is a verbatim copy of the resolved parent route, whose
    // match the child inherits — this consumer resolves parent AND child).
    const consumer = consumerFromMatch(route);

    // Cold-root claim (Review Focus #5): no worktreeName → materialize the
    // parent itself (run the claim route's steps), report ready on the
    // parent, NO child.
    if (worktreeName === undefined) {
      // Idempotence (spec §6), symmetric with the worktree path's childReady
      // skip: an already-fulfilled cold-root claim (parent already ready) is
      // a no-op — no re-running the parent's steps (a gitClone re-run still
      // fetches + rev-parses every poll), no re-reporting. Without the skip,
      // a transient origin outage flips the ALREADY-fulfilled parent to
      // ready:false on the re-run's fetch error — consumer-visible flapping.
      // Retry-on-failure is preserved: ready is false after a failed
      // attempt, so the next poll re-runs the steps.
      if ((await parentStatus(parentName, consumer)).ready === true) {
        emit(`claim ${claimNameOf(claim)} skipped (parent ${parentName} already ready)`);
        return;
      }
      const dir = workDirFor(route, parentName);
      if (!dir.ok) {
        await report("Workspace", parentName, { ready: false, progress: dir.reason });
        emit(`claim ${claimNameOf(claim)} failed: ${dir.reason}`);
        return;
      }
      const ran = await runSteps(preconditionSteps(route), { claimParameters: parameters, workDir: dir.workDir });
      if (!ran.ok) {
        await report("Workspace", parentName, { ready: false, progress: ran.error });
        emit(`claim ${claimNameOf(claim)} failed: ${ran.error}`);
        return;
      }
      await report("Workspace", parentName, { ready: true });
      emit(`claim ${claimNameOf(claim)} fulfilled: parent ${parentName} ready`);
      return;
    }

    // Worktree claim. Sanitize the placement segment BEFORE any
    // materialization or status write (T25-2 review ruling).
    const unsafe = unsafePathSegment(worktreeName);
    if (unsafe !== undefined) {
      await report("Workspace", parentName, { ready: false, progress: unsafe });
      emit(`claim ${claimNameOf(claim)} failed: ${unsafe}`);
      return;
    }

    const childName = childNameFor(parentName, worktreeName);

    // Idempotence (spec §6): an already-fulfilled claim — child exists AND
    // ready — is a no-op.
    if (await childReady(childName, consumer)) {
      emit(`claim ${claimNameOf(claim)} skipped (child ${childName} already ready)`);
      return;
    }

    const dir = workDirFor(route, parentName);
    if (!dir.ok) {
      await report("Workspace", parentName, { ready: false, progress: dir.reason });
      emit(`claim ${claimNameOf(claim)} failed: ${dir.reason}`);
      return;
    }

    // 1. Mark provisioning on the parent.
    const prior = await parentStatus(parentName, consumer);
    await report("Workspace", parentName, {
      ready: false,
      progress: `provisioning ${worktreeName}`,
    });
    emit(`claim ${claimNameOf(claim)}: provisioning ${childName} on ${parentName}`);

    // 2. Run the claim route's preconditions.
    const ran = await runSteps(preconditionSteps(route), { claimParameters: parameters, workDir: dir.workDir });
    if (!ran.ok) {
      // Failure: progress names the why; NO child.
      await report("Workspace", parentName, { ready: false, progress: ran.error });
      emit(`claim ${claimNameOf(claim)} failed: ${ran.error}`);
      return;
    }
    const childPath = ran.path ?? dir.workDir;

    // 3a. Build + PATCH the child (deterministic §5.3 — child.ts; the
    // upsert converges: a duplicate claim re-yields the same name/id).
    // buildChildDocument derives the parent name from the fetched envelope;
    // childNameFor(parentName, …) above derives it from the polled name —
    // the two agree (GET serves doc.raw, whose metadata.name is the key),
    // and any disagreement 400s loud at the upsert's name-match check.
    const parentDoc = await getJson(`/Workspace/${parentName}`);
    if (typeof parentDoc !== "object" || parentDoc === null) {
      const reason = `parent Workspace/${parentName} not found`;
      await report("Workspace", parentName, { ready: false, progress: reason });
      emit(`claim ${claimNameOf(claim)} failed: ${reason}`);
      return;
    }
    const child = buildChildDocument(parentDoc as Record<string, unknown>, claim, childPath);
    const patched = await patchDocument("Workspace", childName, child);
    if (!patched.ok) {
      const err = (await patched.json().catch(() => undefined)) as { error?: string } | undefined;
      const reason = `child PATCH rejected: ${err?.error ?? `HTTP ${patched.status}`}`;
      await report("Workspace", parentName, { ready: false, progress: reason });
      emit(`claim ${claimNameOf(claim)} failed: ${reason}`);
      return;
    }

    // 3b. Child ready, then the final parent report restoring its state.
    await report("Workspace", childName, { ready: true });
    await report("Workspace", parentName, {
      ready: prior.ready,
      ...(prior.progress !== undefined ? { progress: prior.progress } : {}),
    });
    emit(`claim ${claimNameOf(claim)} fulfilled: child ${childName} ready at ${childPath}`);
  }

  /** One poll of one parent's claims. */
  async function pollParent(parentName: string): Promise<void> {
    // GET /claims serves a bare JSON array of claim envelopes (routes.ts).
    const body = await getJson(`/claims?parent=Workspace/${encodeURIComponent(parentName)}&includeReleased=false`);
    if (!Array.isArray(body)) return;
    for (const raw of body) {
      const claim = raw as ClaimEnvelope;
      const route = claimRoute(claim);
      // Review Focus #1: a claim whose route matches none of the configured
      // routes is IGNORED — no materialization, no statusReport.
      if (route === undefined || !isMine(route, config.routes)) {
        emit(`claim ${claimNameOf(claim)} ignored (route not owned)`);
        continue;
      }
      // Enqueue on the parent's serial chain.
      const tail = parentTails.get(parentName) ?? Promise.resolve();
      const next = tail.then(() => fulfill(parentName, claim)).catch(() => undefined);
      parentTails.set(parentName, next);
      await next;
    }
  }

  async function poll(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    try {
      // Parents poll concurrently (serial only within one parent's queue).
      await Promise.all(config.parents.map((parentName) => pollParent(parentName)));
    } catch {
      // A polling fault (registry down, etc.) never takes the loop down.
    } finally {
      polling = false;
    }
  }

  void poll();
  timer = setInterval(() => {
    void poll();
  }, pollIntervalMs);

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
