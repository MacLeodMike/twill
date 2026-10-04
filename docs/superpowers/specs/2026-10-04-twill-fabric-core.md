# Twill fabric core — the protocol

**Status:** Draft (revision 4 — parties + status surface)
**Date:** 2026-10-04
**Scope:** The **agent-agnostic workspace fabric protocol only**. Nothing in
this document is runnable. Every kind-specific spec (workspace, card, mcp,
skill, agentprofile) **inherits this document and may not restate or redefine
it**; disagreements resolve in this document's favor. This document is
**authoritative** for the fabric protocol: where any sibling doc conflicts,
this wins; kind specs, when written, may instantiate it but not redefine it.
**Sibling rationale doc:** `2026-10-02-twill-fabric.md` (what each kind is
for, why the fabric exists, neighboring tools).

---

## 1. Purpose

Twill is a typed directory of fabric objects that agent runtimes **resolve**
into capabilities they can use. Five object kinds exist; only `Workspace` is
built in v1alpha1. This document specifies the **invariants every kind and
every consumer shares** — the envelope, the identity rules, matching, the
resolution algorithm, the party responsibilities, the status surface — so
that kind-specific specs stay small and so that adapters for one kind need
know nothing about another kind.

## 2. Parties (protocol-level)

There are three protocol parties. The words the protocol uses for them are
fixed and ordinal:

- **Registry** — the *yellow pages*. It knows what exists and, given a
  consumer, *selects the route* that should apply. It does not precondition,
  does not attach, does not manufacture object state (it forwards what
  providers report). Like the phone book, it hands you the number; it does
  not call the plumber.
- **Provider** — owns and *materializes* fabric objects. The provider holds
  the storage, runs the preconditions that make a workspace ready, reports
  object state to the registry, and answers consumer wake/materialize calls
  (kind-defined). Materialization is the provider's product.
- **Consumer** — the agent/runtime that resolves and *opens the capability*
  against the provider. Consumers talk only to the registry until the last
  moment, when they use the returned route descriptor to attach.

The three-party split governs all of §6 (resolution) and §8 (status): the
registry selects, the provider materializes, the consumer attaches.
Every kind instantiates those parties in its own way (this spec owns their
responsibilities; kind specs own their concretions).

## 3. The envelope

Every fabric object is one YAML document in the following CRD-forward shape.
The envelope is protocol-fixed; kinds may not alter it:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1     # required; version rules in §10.1
kind: Workspace | Card | MCPServer | Skill | AgentProfile
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

Protocol rules on the envelope:

- **`spec.` top level carries exactly four keys:** `owner`, `routes`,
  `<kindname>`, `parent`. All kind-specific data lives under
  `spec.<kindname>`. This is the mechanically-decidable line between
  protocol fields (which require a version bump to add) and kind fields
  (which don't).
- `apiVersion` is protocol-owned; version rules in §10.1.
- `kind` is one of the five values above; adding kinds is a protocol version
  bump (§10.2).
- `metadata.name` is unique within a kind; there is no cross-kind
  uniqueness.
- `status` is structurally reserved: readers must treat it as opaque,
  writers in v1alpha1 must leave it empty. Readers must not require it to
  exist.
- A document may be **inert**: well-formed but with no resolvable behavior
  yet (§10.3). Inert documents are valid fabric input.

### 4.1 The kind spec object (`spec.<kindname>`)

The lowercase kind name is the name of the kind's spec object: a Workspace
document has `spec.workspace`, a Card has `spec.card`, an MCPServer has
`spec.mcpserver`, a Skill has `spec.skill`, an AgentProfile has
`spec.agentprofile`. The kind spec owns everything under it: its storage-
backing declaration and durable-id (§4.3), its route-type vocabulary (§6.2),
its route-envelope elaborations, its own fields.

This rule is what lets new kinds land without touching the protocol: the
protocol knows where to find `spec.<kindname>`; it does not know or care
what's inside.

### 4.2 Children: `spec.parent`

`spec.parent` is an optional reference to another fabric object, of any
kind. Children are first-class objects — full documents in their own right,
not sub-resources. Children may have children; recursion is unbounded and
cycles are a validation error. Kind specs decide which (child-kind,
parent-kind) crossings are legal; the protocol only fixes the reference
shape.

Children are how the fabric models views over parents: a git worktree of a
repo workspace; a Story Card of an Epic Card. Deletion is **not**
auto-cascading in v1alpha1: deleting a parent does not delete its children
(the wrong side of the mistake to make automatic). Kind specs may declare
cascade semantics in their own specs later.

### 4.3 Storage-backing declaration and durable id

Every kind spec MUST declare `storageBacked: true|false` at
`spec.<kindname>.storageBacked`; classification is by *declaration*, not
inference (an object whose kind spec happens to contain a nested field
named `storage` is the case the declaration guard protects). Storage-backed
kinds (Workspace in v1alpha1) use `spec.<kindname>.storage.id` as the
durable id; all others use `spec.<kindname>.id`. The durable id is minted
once at object creation, immutable under rename, never recycled. Identity
is protocol-required; what the id identifies is kind-defined.

**Derived child ids.** For storage-backed kinds, a child's `storage.id`
MUST incorporate the parent's — e.g. a git-worktree-child of
`ws_01J8Z4` is `ws_01J8Z4-feat-x` — so cross-object aliasing of the same
bytes remains detectable, and the parent relationship is visible in the id
itself. A child is a *view over* the parent's bytes (different `cwd`), not
an alias of them — so its `storage.id` must NOT equal the parent's, but
the fingerprints semantics apply: the child's `storage.fingerprint` matches
the parent's (both point at the same physical volume, which is how the
registry catches the wrong kind of alias). The parent's load-reject rule
same-fingerprint-different-id (see §7) is the mechanism that enforces this;
child objects do not relax it, they participate in it.

Non-storage-backed kinds derive child ids by the same convention for
navigability (Epic `cd_a9` → Story `cd_a9-2` → Task `cd_a9-2-1`); whether
child ids are derived or free on those kinds is kind-owned.

## 5. Owner and principal

Every object has **one** `spec.owner`, a subject string in the grammar
`<scheme>:<id>` (e.g. `user:example`, `team:platform`). Required even
for single-user deployments. v1alpha1 consumers may ignore it for access
decisions but must preserve it in documents they create or mutate.

A **principal** is the request-side claim of identity. `spec.owner` is the
registry-side claim. The protocol keeps them separate so a v2 controller can
bind them. **Routes are not an authorization boundary**: `principal` is
self-declared in v1alpha1 and must be treated as untrusted; matching on
`principal` selects configuration but does not enforce access.

## 6. Routes

A route is one object inside `spec.routes[]`. Routes are **per-consumer
resolvers**: the same object yields different capabilities to different
consumers.

### 6.1 Route envelope (protocol-fixed)

```yaml
- match: {agentLocation: <string>, agentKind: <string>, principal: <string>}   # any subset; omitted = match all
  type: <string>                          # route type; kind-defined enum — §6.2
  precondition: { steps: [ ... ] }        # optional, ordered — §6.3
  # (kind-defined route fields follow)
```

The protocol fixes only the envelope keys: `match`, `type`, `precondition`.
The three names are **reserved on the route envelope** — kind-defined route
fields may not reuse them. Every other key is kind-defined. `match` is
optional; `match: {}` and absent `match` both mean "matches every consumer."
Unknown `match` keys are a spec violation, and routes may not list an
empty-string value in `match`.

### 6.2 Route `type` value

The `type` value is a string. **The set of valid route types is owned by
the kind spec.** The protocol does not enumerate `local`/`ssh`/`k8s-exec`
(Workspace's set) or any others. Each kind spec MUST publish its `type`
vocabulary as a closed, named enum; on selection, a route whose `type` is
not in the serving kind spec's enum is per-route invalid and selection
continues (§7). Onboarding a new kind never requires a protocol version
bump.

A convention, not a rule: kinds whose routes concern the same physical
mechanisms SHOULD reuse the same `type` names so the fabric reads
coherently.

### 6.3 `precondition.steps[]`

A route may declare `precondition`: an **ordered list** of provisioning
steps the **provider** runs *before* the workspace is reported ready. Each
step has a kind-defined `type` and fields. Steps are idempotent;
short-circuit on the first failure. The protocol fixes only the existence,
order, and ownership (provider, not consumer-and-not-registry) of
precondition steps: a resolved route descriptor carries the steps
informationally; consumers MUST NOT execute them (§8 makes the "report
readiness" mechanism that obviates consumer execution).

## 7. Resolution and matching

Resolution maps `(kind, name, consumer)` to one of three outcomes: an
`Attached` route descriptor, `NoMatch`, or `Unreachable`. The important
shape: resolution is the **registry's selection**, not the consumer's
attach. The algorithm:

```
resolve(kind, name, consumer) -> Attached | NoMatch | Unreachable:
  obj    <- registry.get(kind, name)
  routes <- obj.spec.routes.filter(matches(r.match, consumer))        # §7.1
  if routes is empty: return NoMatch(obj, consumer)
  errors <- []
  for r in routes (in declared order):
    if r.type not in kind spec's enum:
      errors.append((r, "unknown route type")); continue
    st <- registry.statusFor(obj, r)                                  # §8
    if not st.selectable:                                             # kind-mapped
      errors.append((r, st.reason)); continue
    return Attached(descriptor(obj, r, st))                           # §7.2
  return Unreachable(obj, consumer, errors)
```

Rules:

- **Three distinct results.** `NoMatch` = no route selected this consumer.
  `Unreachable` = at least one candidate, none survived. The last result
  carries per-route errors so callers can tell whether the whole set
  failed or only earlier candidates did.
- **Order before readiness.** A route lower in the list is selected only
  if every earlier matching route was not selectable. Matching is not a
  health check.
- **Selectability, not reachability.** The registry does not probe; it
  consults the status surface (§8) for the route's most-recent reported
  state. Whether that's "selectable" is kind-mapped (for Workspace, the
  lifecycle map §8.2 documents is the answer).
- **No attach, no precondition execution in the registry path.** The
  returned descriptor informationally carries the route (including its
  `precondition`); consumers MUST NOT execute the steps (§6.3). What the
  consumer does *next* — wake/then-attach — is the consumer + provider
  handshake, and the registry is not in it.
- **Resolver portability.** Given the same documents, the same consumer
  declaration, and the same status observations, two resolvers (registry
  service; an in-adapter fallback) MUST make the same selection. Live
  observations legitimately differ over time; the selection rule must
  not.

### 7.1 Matching semantics

Matching between a route's `match` and a consumer is **exact string
equality on every key `match` specifies**; the consumer's declaration
supplies `agentLocation`, `agentKind`, `principal` (each a string, each
required, each possibly empty). A route matches iff every key it lists
equals the consumer's value for that key. No wildcards, no case folding,
no regexes.

**The empty-string consumer.** A consumer may declare any field as `""`
(anonymous/default; a consumer with no principal is `principal: ""`). Empty
consumer values are real, matchable values. Conversely, **a route may not
list an empty string in `match`** (`match: {principal: ""}` is a spec
violation): `""` is the sentinel for "absent," and making the sentinel a
matchable value would double its meaning.

**Guidance (non-normative):** versioned `agentKind` values in routes are a
footgun; match on the runtime family (`pi`, `hermes`).

### 7.2 The Attached descriptor

The registry's `Attached` is a *selection*, not a capability:

```json
{
  "kind": "Workspace",
  "name": "workstation-repos",
  "durable_id": "ws_01J8Z4-workstation-repos",
  "route": { "match": {...}, "type": "ssh", "address": "...", "path": "...",
             "precondition": {"steps": [...]} },
  "status": {
    "ready": true,
    "claimedBy": [],
    "progress": "mounted at /data/vol-2c4f1a",
    "asOf": "2026-10-04T03:12:11Z",
    "source": "live"
  }
}
```

Consumers use the `status.progress` vocabulary to convey kind-specific
state semantics to their own logs/UIs; consumers do not parse it. The
adapter is the actor that turns this descriptor into a capability (for
Workspace: `WorkspaceEnv`), and is responsible for stamping
`cap.identity = durable_id` (§4.3).

## 8. Status surface: providers report; registry forwards

The registry never authors readiness. The surface is deliberately tiny and
generic so it covers every kind:

| Field | Type | Protocol meaning |
|---|---|---|
| `ready` | bool | "a consumer may attach now" (kind-mapped from the provider's kind lifecycle) |
| `claimedBy` | `[consumers]` | who currently holds a claim (empty = unclaimed; claimed = RWO-attached / RWX-shared) |
| `progress` | string | kind-owned free-form text for why/how (cold / restoring / cloned-at-abc123 / ...) — consumer-visible, never parsed |
| `asOf` | rfc3339 | the provider-supplied observation time |
| `source` | `live` \| `cached` | registry-set: whether this observation is live-queried or from cache |

That's the entire protocol-owned status shape. `ready` and `claimedBy` are
the two the protocol *enforces*; the rest is the flavor.

`claimed` is the name over `attached` deliberately: a Card is claimed, a PV
is claimed, a workspace is claimed; the word spans kinds. `claimedBy` is a
list, not a boolean, for lease v2 compatibility and RWX-shared-attachment
visibility.

Providers report `claimedBy` **per route** (a route's claim state is a
property of the route+provider pair, not the document); the registry keys
its cache per (document, route).

`ready` is kind-mapped: the kind spec documents which of the provider's
internal states map to `ready: true`. For Workspace in v1alpha1 (see the
workspace kind spec §5): `provisioning`/`cold`/`degraded` map to
`ready: false`; `ready` maps to `ready: true`; `down` and unknown values
map to `ready: false`. A provider may map multiple lifecycle states onto
the same protocol bool — the RWO-example is the canonical one.

`claimedBy` on the *status surface* describes the route's current claimed
state for both access modes (claim on an RWO route = "one consumer holds";
claim on an RWX route = "the shared-consumer set").

### 8.1 Provider interface for status

Providers are reachable by the registry on a configured-by-deployment
address surface (v1alpha1: registry-side YAML carries the provider handle
per Workspace; discovery is v2). The registry either polls the provider
(`GET /status`, short timeout, falls back to cache) or accepts pushes
(`POST <registry>/<kind>/<name>/statusReport`, deployment-token-auth).
Both transports carry the same JSON shape.

The cache has a TTL, kind-spec-tunable (v1alpha1: 60s). A status entry
older than the TTL is used with `source: cached`. A provider that fails
to answer is per-route-unselectable (`down`), and the status surfaced
to consumers is the cached one with `source: cached`.

### 8.2 Caching mode and the "dead-provider" case

The registry's status answer is the **fresher of** the live query (if the
provider answers within its timeout) and the latest cache. The `source`
field in the descriptor carries which; consumers can decide how to treat
a stale `ready` (an entry from 2 hours ago with `source: cached` is
judged by the adapter, not hidden).

### 8.3 Load-time and reload-time reject (consolidated)

The registry MUST reject the document set on (re)load if any two documents
share a populated `storage.fingerprint` with different `storage.id`s. The
(re)load-time semantic from §6.3 in earlier drafts is consolidated here:
on reject, the registry serves the **last-good document set** (no hard
exit; single-replica availability prevails), reports its own degraded
surface (the kind spec chooses the surface; v1alpha1's choice is `GET
/twill/v1alpha1/health` returning `{"documentSet": "stale", "rejectedAt":
..., "reason": ...}`), and logs the rejection. The "serve last-good, don't
outage on a bad config push" rule is the actual availability contract.

Kind specs decide what "the document set" means (the watched ConfigMap,
the bind-mount tree, or both).

## 9. Persistence and transport are out of scope (deliberately)

This protocol does not specify how documents are stored or served. The
registry's YAML documents are the source of truth; ConfigMap vs file tree
vs CRD is the registry service's decision. The protocol only requires doc
shape, resolution behavior, discovery shape, and the status surface.

## 10. Versioning and discovery

### 10.1 Version policy

`apiVersion: twill.bitwiseoperations.ca/v1alpha1` permits, without a version
bump: adding fields inside `spec.<kindname>`; adding or refining kind-
defined route types; refining kind-specific matching-relevant semantics
where the protocol leaves them open; adding values to the provider's
`progress` vocabulary (it is free-form).

v1alpha1 does **not** permit: adding/removing/renaming any of the four
`spec.` top-level keys; adding consumer dimensions to the match selector;
changing matching semantics; changing the durable-id path rule; adding
fields to the status surface (§8's table); making `status` meaningful to
readers; adding fields to the `Attached` descriptor's free-form section
(the named-protocol shape). Any such change is a new `apiVersion`.

### 10.2 Enum policy (kinds)

The five v1alpha1 kinds are protocol-fixed. Adding a new kind is a
protocol version bump. (Kind-defined route types and kind spec fields do
not trigger this.)

### 10.3 Discovery

Abstract shape — a list of object references:

```
{ kind: <string>, name: <string>, durable_id: <string>, resolvable: bool }
```

`resolvable` is registry-side and per-object: `true` iff the object's kind
has a registered kind-runner and `spec.routes` is non-empty. Discovery
lists **every object the registry holds, inert included**. The concrete
transport (HTTP, file walk, CLI output) is kind-spec/registry-service
business; this document fixes only the abstract shape.

## 11. Non-goals (restated in protocol terms)

- Not a workflow engine: no state machines, no transitions.
- Not a secret manager: credential refs are pointers.
- Not an agent runtime.
- Not a delegation protocol: AWCP inputs live in the composite rationale
  (`2026-10-02-twill-fabric.md` §7.1) and land in whatever kind spec
  claims them.

## Appendix A. Terms

- **Capability** — the kind-specific thing a consumer gets on a successful
  resolver→adapter flow (for Workspace: `WorkspaceEnv`; not a protocol
  concept).
- **Consumer** — the tuple `{ agentLocation, agentKind, principal }` making
  a resolve call; self-declared, untrusted in v1alpha1.
- **Provider** — owns + materializes + reports state for fabric objects.
- **Registry** — selects routes + serves the status surface; never authors
  readiness.
- **Durable id** — per §4.3: `spec.<kindname>.storage.id` (storage-backed)
  or `spec.<kindname>.id` (others); minted at creation, immutable.
- **Inert object** — a well-formed document with no resolvable behavior
  (§10.3's `resolvable: false`).
- **Storage-backed kind** — `spec.<kindname>.storageBacked: true`; incurs
  the write-serialization invariant of §4.3 and the fingerprint reject
  rule of §8.3 (v1alpha1: Workspace).
- **Claimed / claimedBy** — the protocol's name for "currently has consumers
  attached" (chosen over "attached": a Card is claimed, a PV is claimed,
  a workspace is claimed — the word spans kinds).
- **Parent / child** — §4.2's first-class object reference; children are
  full objects in their own right; cycles are rejection.
- **Route descriptor** — the `Attached` payload of §7.2: a selection, not
  a capability.
