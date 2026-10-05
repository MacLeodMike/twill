# Twill fabric core — the protocol

**Status:** Draft (revision 10 — lineage presence + P2 sweep)
**Date:** 2026-10-04
**Scope:** The **agent-agnostic workspace fabric protocol only**. Weakest-link
doc: every kind spec inherits and may not restate or redefine it. This doc is
**authoritative**; disagreements resolve in its favor.

Six kinds exist in v1alpha1. `Workspace` and `Claim` are built; `Card`,
`MCPServer`, `Skill`, `AgentProfile` are reserved or schema-pinned.

---

## 1. Purpose

Twill is a typed directory of fabric objects that agent runtimes **resolve**
into capabilities. This document specifies the **invariants every kind and
every consumer shares** — envelope, identity, matching, resolution, party
responsibilities, the status surface, claims — so that kind specs stay
small and adapters for one kind need know nothing about another.

## 2. Parties (protocol-level)

- **Registry** — the *menu*. It knows what exists and, given a consumer,
  *selects the route* that should apply. It does not precondition, does not
  attach, does not author object state (it forwards what providers report,
  minus `claimedBy` which it derives from its own documents). It also does
  not order the pizza: consumers attach to providers directly with the
  returned route; the registry just hands out the right address.
- **Provider** — owns and *materializes* fabric objects. Runs preconditions,
  reports state to the registry, picks up and fulfils claims. Materialization
  is the provider's product.
- **Consumer** — the agent/runtime that resolves and *opens the capability*
  against the provider. Talks only to the registry for selection and claims,
  then to the provider for everything else.

## 3. The envelope

Every fabric object is one YAML document in the following CRD-forward shape.
The envelope is protocol-fixed; kinds may not alter it:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1     # required; version rules in §10.1
kind: Workspace | Card | Claim | MCPServer | Skill | AgentProfile
metadata:
  name: <string>          # unique within this kind
  labels: {<class keys>}  # optional
spec:
  owner: <subject>        # REQUIRED — §5
  routes: [<route>]       # ordered, may be empty — §6
  <kindname>: { ... }     # the kind's spec object; name = lowercase kind — §4.1
  parent: { kind: <string>, name: <string> }   # optional — §4.2
status: {}                # reserved; controller-owned in v2, reader-ignored
```

- `spec.` top level carries exactly four keys: `owner`, `routes`,
  `<kindname>`, `parent`. All kind-specific data lives under
  `spec.<kindname>`.
- `kind` is one of six values; adding kinds is a protocol version bump.
- `metadata.name` is unique within a kind.
- `status` reserved: readers opaque, writers in v1alpha1 leave empty.
- A document may be **inert** (well-formed, no resolvable behavior, listed
  with `resolvable:false`).

### 4.1 `spec.<kindname>`

The lowercase kind name is the name of the kind's spec object. All kind-
specific data, rules, and fields live under it: durable-id rules (§4.3),
route-type vocabulary (§6.2), kind-invented matching semantics, lifecycle
to status-surface mappings (§8). The protocol knows where to find it; it
does not know or care what's inside.

### 4.2 Children: `spec.parent`

`spec.parent` is an optional reference to another fabric object, of any
kind. Children are first-class objects, full documents in their own right.
Children may have children; recursion is unbounded; cycles are loader-
rejected. Kind specs decide which (child-kind, parent-kind) crossings are
legal. Deletion is **not** auto-cascading in v1alpha1; kind specs may
declare cascade semantics.

Children are how the fabric models views over parents: a git worktree of a
repo workspace; a Story Card of an Epic Card; a Claim of its claimed
resource.

### 4.3 Storage-backing declaration and durable id

Every kind spec MUST declare `storageBacked: true | false` at
`spec.<kindname>.storageBacked`. Storage-backed kinds (Workspace in
v1alpha1) use `spec.<kindname>.storage.id` as the durable id; all others
use `spec.<kindname>.id`. Minted once at creation, immutable under rename,
never recycled. What the id identifies is kind-defined.

**Derived child ids.** Storage-backed kinds: a child's `storage.id` MUST
incorporate the parent's (e.g. `ws_01J8Z4-payments-repo-feat-x` is a
worktree child of `ws_01J8Z4-payments-repo`) and MUST differ (children
are views, not aliases). A
child's `storage.fingerprint` MUST equal the parent's (same physical
volume). Whether documents sharing a `fingerprint` are load-accepted or
rejected is governed by the lineage rule (§8.3).

Non-storage-backed kinds derive child ids by the same convention for
navigability; strictness is kind-owned.

## 5. Owner and principal

`spec.owner`: a subject string `<scheme>:<id>` (e.g. `user:example`,
`team:platform`). Required even single-user. v1alpha1 consumers may ignore
it for access decisions; must preserve in mutations.

`principal` is the request-side claim; self-declared and untrusted in
v1alpha1. **Routes are not an authorization boundary**; matching selects
configuration, not permissions.

## 6. Routes

### 6.1 Route envelope (protocol-fixed)

```yaml
- match: {agentLocation: <string>, agentKind: <string>, principal: <string>}   # any subset; omitted = matches all
  type: <string>                          # route type; kind-defined enum — §6.2
  precondition: { steps: [ ... ] }        # optional, ordered — §6.3
  # (kind-defined route fields follow — static document data only)
```

### 6.2 `type` value

Kind-owned closed enum. The protocol does not enumerate any values. Each
kind spec MUST publish its enum; unknown `type` at resolution = per-route
invalid.

### 6.3 `precondition.steps[]`

An ordered list of provisioning steps the **provider** runs *before* the
object is reported ready. Kind-defined `type` and fields. Idempotent;
short-circuit on failure. **Consumers MUST NOT execute steps** — what the
descriptor carries is informational. This is the "don't let the consumer
rebuild what the provider was supposed to materialize" rule; when the
consumer has to do it itself, the provider is just leasing bytes.

## 7. Resolution and matching

`resolve(kind, name, consumer) -> Attached | NoMatch | Unreachable`.

The registry-side algorithm (selection, not attach; no precondition
execution):

```
resolve(kind, name, consumer) -> Attached | NoMatch | Unreachable:
  obj    <- registry.get(kind, name)
  if obj is missing: return NoMatch(kind, name, consumer)
  routes <- obj.spec.routes.filter(matches(r.match, consumer))     # §7.1
  if routes is empty: return NoMatch(obj, consumer)
  errors <- []
  for r in routes (in declared order):
    if r.type not in kind spec's enum: errors.append((r, "unknown route type")); continue
    st  <- registry.statusFor(obj, r)                              # §8
    if not st.selectable: errors.append((r, "not selectable")); continue
    return Attached(routeDescriptor(obj, r, st))
  return Unreachable(obj, consumer, errors)
```

- Three distinct results, per-route errors on Unreachable.
- **Order before readiness**: a route lower in the list is selected only if
  every earlier matching route was not selectable. Matching is not a
  health check.
- **Selectability, not reachability**: the registry consults the status
  surface (§8); what "selectable" means is kind-mapped. Selectability is
  `st.selectable := st.ready OR st.provisionable` (a `ready` workspace
  selects via `ready: true`; a cold workspace selects via
  `provisionable: true`).
- **Static route data**: returned `route` is a verbatim copy from the
  stored document (no injected fields, no per-attach dynamic data).
- **Descriptor pinning**: top-level keys (`kind`, `name`, `durable_id`,
  `route`, `status`) are protocol-closed; route-envelope keys are
  protocol-closed; route kind-fields are kind-owned but must be static
  document data.

### 7.1 Matching

Exact string equality on every key `match` specifies. Consumer declares
`agentLocation`, `agentKind`, `principal` (all required, possibly empty).
Empty in `match` is a violation. No wildcards, no case folding, no
version-suffix wildcards.

The empty-string consumer: consumers may send `""` (anonymous); the
sentinel is not matchable, so routes may not target anonymous consumers
explicitly. (Principal-less consumers match only routes that don't list
`principal`.)

Match guidance: match on runtime family (`pi`, `hermes`), not versioned
`pi/0.99.1`.

### 7.2 The Attached descriptor

```json
{
  "kind": "Workspace",
  "name": "workstation-repos",
  "durable_id": "ws_01J8Z4-workstation-repos",
  "route":   { /* verbatim from the document */ },
  "status": {
    "ready": true,
    "provisionable": false,
    "claimedBy": [],
    "progress": "mounted at /data/vol-2c4f1a",
    "asOf": "2026-10-04T03:12:11Z",
    "source": "live"
  }
}
```

The adapter turns this into a capability and stamps
`cap.identity = durable_id`.

## 8. Status surface: providers report; registry forwards

Protocol-owned shape — six fields (closed to removal/rename; additive
per §10.1):

| Field | Type | Meaning |
|---|---|---|
| `ready` | bool | "a consumer may attach now" (kind-mapped from the provider's lifecycle) |
| `provisionable` | bool | "the provider can lazily materialize on demand" (kind-mapped) |
| `claimedBy` | `[claims]` | who currently holds claims (derived from Claim documents — see §9); each element is `{name, owner, principal, claimedOn}` — the Claim's metadata.name, `spec.owner`, `spec.claim.principal`, and `spec.claim.claimedOn`. Adapters identify their own claims by `principal` |
| `progress` | string | kind-owned free-form text for humans; advisory, never parsed |
| `asOf` | rfc3339 | the provider-reported observation time |
| `source` | `live` \| `cached` | registry-set: which side of the cache this observation came from |

`ready` and `claimedBy` are the protocol-enforced pair. `claimed` is the
name over `attached` deliberately: a Card is claimed, a PV is claimed, a
workspace is claimed — the vocabulary spans kinds.

`ready` and `provisionable` are kind-mapped: the kind spec documents which
of the provider's internal lifecycle states map onto `true`/`false` on
each. (Core does not enumerate mapping values — that's the kind's business.
Rule of thumb: cold ⇒ provisionable; ready ⇒ ready; dead ⇒ neither.)

**Staleness and dead providers.** A provider that fails to answer within
the registry's query timeout yields the cached entry with
`source: cached`. Stale entries on selection are `ready: false`,
`provisionable: false`; the descriptor still carries the cached
`progress`/`asOf` so adapters can judge. Claims are *not* erased by
staleness: `claimedBy` is document-derived (§9), not provider-derived,
so provider hang does not vanish existing claims.

**Never-observed documents.** A document whose provider has never
reported (no cache entry, no live answer — e.g. a freshly registered
workspace whose provider hasn't polled yet) takes the kind spec's
declared **default status**: for Workspace, `ready: false,
provisionable: true` (a registered workspace is presumed lazily
materializable until the provider says otherwise), `source: cached`,
`progress: "no provider report yet"`. `claimedBy` is always derived
from Claim documents (§9), never defaulted. Each kind spec declares its
own default; the registry applies it without contacting the provider.

The cache has a TTL, kind-spec-tunable (v1alpha1: 60s).

## 8.3 Load-time and reload-time reject (the lineage rule)

The registry MUST reject the document set on (re)load when two documents
conflict on identity, where conflict is computed as:

- **Fingerprint collision without lineage**: two documents share a
  populated `storage.fingerprint` and have different `storage.id`s, AND
  their ancestor sets do not intersect **at a document present in the
  set**. A document's **ancestor set is self-inclusive**: the document
  itself plus its transitive `spec.parent` references (kind+name).
  Lineage is conferred only by an intersecting ancestor that is **loaded
  in the document set** — two documents citing the same *missing* parent
  name share no lineage (otherwise two unrelated roots could bypass
  rejection by copy-pasting a fictitious common parent). Cycle rejection
  (§4.2) precedes lineage computation. Parent/child pairs and siblings
  under one present root are the declared-alias case and load cleanly;
  two *unrelated* roots claiming one physical volume are the corruption
  case and are rejected.
- **Duplicate durable id**: two documents carry the same durable id
  (`storage.id` or `<kindname>.id`) — always rejected regardless of
  fingerprint or lineage.
- **Orphan claims are not rejections**: a Claim whose parent reference
  does not resolve in the document set (parent deleted while the claim
  persisted) is marked inert and reported in the health surface's
  `warnings` field (`GET /twill/v1alpha1/health` → `{"documentSet":
  "current", "warnings": [{orphan claim refs}]}`), never a set-level
  rejection — one crashed consumer must not be able to brick the
  registry.

On rejection the registry serves the **last-good document set** (no hard
exit; single-replica availability prevails), reports its degraded surface
(`GET /twill/v1alpha1/health` → `{"documentSet": "stale",
"rejectedAt": <rfc3339>, "reason": ...}`; on a valid set it returns
`{"documentSet": "current", "warnings": [...]}` — `warnings` is the
non-rejecting report channel, used for orphan claims and for
overlay-shadowed watched-source edits), and logs the rejection. Cold start with a
rejected set: serve the **empty** registry, `documentSet: stale`, log the
rejection. Kind specs decide what "the document set" means (watched
ConfigMap, bind-mount, or both).

## 8.4 Claims occupy the storage, not the route

A claim's occupancy identity is `claimedOn: {fingerprint, durable_id}` —
the fingerprint of the storage the claim occupies, plus the durable id of
the object it was claimed against. **`claimedBy` derivation keys on
`fingerprint` for storage-backed kinds and on `durable_id` for
non-storage-backed kinds**: two Workspaces with the same fingerprint see
each other's claims regardless of which route or which parent/child view
either consumer resolved through. That is what makes RWO exclusive across
views (including parent+child views of the same pool). **Non-storage-
backed kinds leave `fingerprint` absent/empty** (there is no physical
volume to occupy; exclusivity on e.g. a Card is per-object by definition).

## 9. Claims are first-class children

A claim is a document of `kind: Claim`, created by the consumer's adapter
and registered in the registry like every other document. This is the
PVC-against-StorageClass pattern, done over the fabric:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Claim
metadata: { name: claim-ws-01J8Z4-feat-x-pi-session-a7 }
spec:
  owner: user:example
  routes: []                                  # claims don't route
  claim:
    storageBacked: false
    id: cl_...
    principal: "pi/0.99.1@workstation"        # the claiming consumer identity
    route: { type: ssh, address: "..." }      # the resolved route this claim binds
                                              # (which provider is on the hook);
                                              # provider binding = exact match on
                                              # the route object as returned
    parameters:
      branch: feat-x
      worktreeName: feat-x                    # parameters the provider
                                              # materializes from
    claimedOn: {fingerprint: vol-2c4f1a, durable_id: "ws_01J8Z4-payments-repo"}
    released: false                           # set true to release (PATCH)
  parent: { kind: Workspace, name: payments-repo }
status: {}
```

Rules:

- Claims are first-class children; `spec.parent` is the **existing,
  registered** resource being claimed (the repo workspace, the pool
  root). Claims never name a not-yet-materialized child as parent —
  the child's identity (`branch`, `worktreeName`, ...) is carried in
  `spec.claim.parameters`, and the **provider authors the child document**
  once materialization succeeds (via the registry's document surface).
  Missing parents are rejected at **POST time** (create-time validation,
  immediate error); a parent deleted *after* the claim exists yields an
  inert orphan claim per §8.3, not a set-level rejection.
- `spec.claim.route` records which resolved route (and therefore which
  provider handle) the claim binds; the provider claims read-path filters
  on it, so two providers backing one fingerprint never both materialize.
- `spec.claim.parameters` is kind-defined for the claimed kind
  (Workspace's parameters are things like `branch`, `worktreeName`).
- `claimedOn` carries fingerprint + durable_id (§8.4); fingerprint is
  absent for non-storage-backed kinds.
- Claims are **document-derived**: the registry derives `claimedBy`
  (elements `{name, owner, principal, claimedOn}`) from all un-released
  Claim documents of a given `claimedOn` key (fingerprint for
  storage-backed kinds, durable id otherwise — §8.4) — the provider's
  statusReport updates `ready`/`provisionable`/`progress`/`asOf` but
  never carries `claimedBy`.
- **Release**: consumers release via `PATCH` on their Claim document
  setting `spec.claim.released: true`. The registry's next status
  surface computation removes it from `claimedBy`.
- **v1alpha1 claims are advisory**: there is no enforcement that a second
  consumer may not proceed against a `claimedOn` owned by another claim;
  adapters SHOULD warn; RWO lease mechanics are v2. Claims are the
  *visibility* mechanism (who's working where); enforcement layers later.
- Claim documents persist until released; crashed consumers' claims
  remain until operator cleanup (v1alpha1 does not auto-GC claims).

The provisioning trigger uses this mechanism: a claim whose `claimedOn`
object is currently `provisionable: true` causes the *provider* to begin
materialization as soon as the claim is visible through the provider's
claim-read path (see §11).

Claim ownership in v1alpha1: the registry authors `claimedBy` from its
Claim documents; the provider polls the registry's claims read-path;
the consumer's adapter is responsible for release.

## 10. Versioning and discovery

### 10.1 Version policy

`apiVersion: twill.bitwiseoperations.ca/v1alpha1` permits additive changes
without a version bump: new fields *anywhere except as-called-out-below*;
new values in kind-owned vocabularies; new namespaced extensions in
`progress`; new kind-owned route types; new status fields (additive:
readers MUST ignore unknown status fields); new claims of existing kinds.
v1alpha1 does **not** permit: removing or renaming any of the four
envelope keys; changing the shape of `match`; changing the match selector
dimensions; changing the durable-id rule; changing the `precondition`
envelope; removing or renaming Attached descriptor top-level keys;
subtracting status fields; changing `claimedOn` shape. Any such change
is a new `apiVersion`. (Protocol surfaces are **closed to
removal/rename, additive-only**: new fields may be added anywhere
readers are told to tolerate them.)

v1alpha1 is pre-release: payload shapes may tighten between iterations;
readers MUST tolerate unknown fields.

### 10.2 Kinds

Six kinds are protocol-fixed: `Workspace`, `Card`, `Claim`, `MCPServer`,
`Skill`, `AgentProfile`. Adding a kind is a version bump.

### 10.3 Discovery

Abstract shape:

```
{ kind: <string>, name: <string>, durable_id: <string>, resolvable: bool,
  parent?: { kind: <string>, name: <string> } }
```

`resolvable` per registry-side evaluation: kind has a registered kind-
runner and routes are non-empty. Discovery lists every document held by
the registry, inert included.

## 11. Persistence and transport are out of scope (deliberately)

The protocol does not specify how documents are stored or served.
Registry-side implementation details (the YAML-watch file source, the
in-memory or on-disk index, the provider-claim-read-path shape) belong to
the registry-service spec in the workspace kind spec, not to core.

## 12. Non-goals

- Not a workflow engine.
- Not a secret manager.
- Not an agent runtime.
- Not a delegation protocol (AWCP is a v2 design input in the composite
  rationale).

## Appendix A. Terms

- **Capability** — the kind-specific thing an adapter mints after
  resolution (not a protocol concept).
- **Consumer / Provider / Registry** — §2's three parties.
- **Durable id** — §4.3.
- **Inert** — §10.3's `resolvable: false`.
- **Child** — §4.2.
- **Claim** — a first-class child (kind `Claim`) of a claimed resource;
  visibility and the lazy-provisioning trigger.
- **Claimed / claimedBy** — derived from Claim documents; "has consumers"
  in kind-spanning language.
- **ClaimedOn** — occupancy identity `{fingerprint, durable_id}` (§8.4).
- **Route descriptor** — §7.2's Attached payload.
- **Selectable** — `ready OR provisionable`, kind-mapped (§7).
- **Storage-backed** — §4.3 (v1alpha1: Workspace).
