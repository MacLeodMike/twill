# Twill fabric core — the protocol

**Status:** Draft
**Date:** 2026-10-04
**Scope:** The **agent-agnostic workspace fabric protocol only**. Nothing in this
document is runnable. Every kind-specific spec (workspace, card, mcp, skill,
agentprofile) **inherits this document and may not restate or redefine it**;
disagreements resolve in this document's favor.
**Sibling rationale doc:** `2026-10-02-twill-fabric.md` (what each kind is for,
why the fabric exists, neighboring tools).

---

## 1. Purpose

Twill is a typed directory of fabric objects that agent runtimes **resolve**
into capabilities they can use. Five object kinds exist; only `Workspace` is
built in v1. This document specifies the **invariants every kind and every
consumer shares** — the envelope, the identity rules, the route vocabulary,
and the resolution algorithm — so that kind-specific specs stay small and so
that adapters for one kind need know nothing about another kind.

The single question this protocol answers:

> Given a **name** and a **consumer**, how does the consumer get a usable
> capability, and how is it prevented from silently colliding with another
> consumer of the same physical resource?

## 2. Objects and the common envelope

Every fabric object is one YAML document in the following CRD-forward shape.
This shape is **fixed by the protocol**, not by kinds:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1     # required; version rules in §7
kind: Workspace | Card | MCPServer | Skill | AgentProfile
metadata:
  name: <string>                # registry-unique within (kind)
  labels: {<class keys>}        # optional; kind-defined
spec:
  storage: { id: <string>, fingerprint: <string, optional> }   # see §3
  owner: <subject>              # REQUIRED — §4
  routes: [<route object>]      # ordered, may be empty — §5
  profile: { ... }              # kind-defined; opaque to protocol
status: {}                      # reserved; controller-owned in v2, reader-ignored
```

Protocol rules on the envelope:

- `kind` is one of the five values above. No others may be defined without a
  protocol version bump (§7).
- `metadata.name` is unique within a `kind`; there is no cross-kind
  uniqueness requirement.
- `spec` carries at least the fields above; kinds add their own under
  clearly-namespaced subkeys (`profile` is the designated home) and **must
  not** put kind fields at `spec.` top level (keeps the common shape stable).
- `status` is structurally reserved: readers must treat it as opaque, writers
  (v1: humans) must leave it empty. v1 readers must not require it to exist.
- A document may be *inert*: well-formed but with no behavior yet. Inert
  documents are valid input to the protocol; discovery lists them (§6.3).

## 3. Identity and the one correctness invariant

`spec.storage.id` is the object's **durable identity**. It is:

- Minted once when the object is created, never recycled.
- **Immutable under rename.** Renaming `metadata.name` must not change
  `spec.storage.id`.
- Carried through every route, adapter, and capability derived from the
  object. A capability minted from an object must stamp the object's
  `spec.storage.id` into the capability's identity.
- The *only* mechanism by which two consumers are guaranteed to serialize
  correctly when their capabilities point at the same physical resource.

Why this field exists: the ecosystem's workspace runtimes serialize file
writes by **environment id + path**. Any two consumers that resolve to the
same physical bytes must mint capabilities with the **same** `storage.id` —
this is the write-serialization invariant. Runtimes without the concept
inherit it by adopting `spec.storage.id` as their capability id when talking
to twill-resolved resources.

`spec.storage.fingerprint` is an optional out-of-band verifier (volume UUID,
machine-id, content hash). The protocol treats it as advisory in v1; it is the
v2 hook for controller-verified identity and is **not** load-bearing yet.

## 4. Owner and principal

Every object has **one** `spec.owner`, a subject string. Required even for
single-user deployments — it is the day-one access-control hook and its
absence in v1 would force a migration later. v1 consumers may ignore it for
*access decisions* (v1 auth is deployment-shaped, not schema-shaped), but
must preserve it in documents they create or mutate.

A **principal** is the authenticated subject of a resolution request.
`spec.owner` is the registry-side claim; principal is the request-side claim.
The protocol keeps them separate so a v2 controller can bind them.

## 5. Routes

A route is an object inside `spec.routes[]`. Routes are **per-consumer
resolvers**: the same object yields different capabilities to different
consumers, and the route set is how that is declared.

### 5.1 Route shape (protocol-fixed)

```yaml
- match: {agentLocation: <string>, agentKind: <string>, principal: <string>}   # any subset; omitted = matches all
  type: local | ssh | k8s-exec | agent        # §5.2
  # type-specific fields follow (address, path, address, ...; kind specs define them)
  precondition: { type: <kind-defined>, ... } # optional — §5.3
```

Protocol enforces only the envelope of a route: the presence of `match` (a
consumer selector), `type`, optional `precondition`. Everything inside a
route besides `match`/`type`/`precondition` is **kind-defined** and opaque
to core.

Ordering is meaningful: **first route whose `match` fits the consumer and
whose target is reachable wins.** `match` uses subset semantics — a route
matches if every key it specifies equals the consumer's corresponding field.
Unspecified fields match anything.

### 5.2 Route types (protocol-fixed vocabulary)

`type` is one of four values. The list is protocol-fixed; adding a type is a
protocol version bump. The *semantics of each type* are kind-defined — this
spec only names them so that all kinds share the vocabulary.

| `type` | Protocol meaning | Kind-defined details |
|---|---|---|
| `local` | Capability resolves through the consumer's own filesystem/shell | path, resolve steps |
| `ssh` | Capability resolves over SSH (exec/sftp) to a target host | address, path |
| `k8s-exec` | Capability resolves by exec into a k8s pod/PVC | pod/pvc, path |
| `agent` | Capability is delegated to a remote executor, lease-bounded — see §7 of the rationale doc (`2026-10-02`, §7.1) and the workspace kind spec | lease terms, executor selector |

`agent` is protocol-reserved today (no kind may define elaborations of it in
v1alpha1), present in the vocabulary **only** so that future delegation work
doesn't require a schema bump. AWCP (arXiv 2602.20493) is the reference
model when it lands.

### 5.3 `precondition`

A route may declare a `precondition`: an ordered, idempotent provisioning
step the resolver runs **before** attaching the capability. The protocol
fixes only the existence and ordering of preconditions: `precondition` is a
single object with a kind-defined `type`; multiple provisioning steps are
expressed by kind spec as nested/ordered structure, not as a list at the
route envelope (so kind specs own that shape). Preconditions must be
**idempotent** — re-resolving a route that was already resolved must not
re-do provisioning destructively.

Typical precondition *types* (`gitClone`, `worktree`, `pvcBind`,
`remoteMkdir`, `mountCheck`) are kind-vocabulary, not protocol vocabulary;
they live in the workspace kind spec.

## 6. Resolution

Resolution is the only operation the protocol specifies. It maps
`(objectName, consumer)` to either an **attached capability** or an
explicit unreachable result. Implementations conform to this algorithm;

```
resolve(objectName, consumer) -> Result<capability, Unreachable>:
  obj    <- registry.get(kind, objectName)         # any backend: file, api, ...
  routes <- obj.spec.routes.filter(matches(match, consumer))    # subset match, §5.1
  for r in routes (in declared order):
    if not reachable(r): continue                  # per-kind reachability probe
    if r.precondition exists: run it               # idempotent, §5.3
    cap  <- kind.attach(r)                          # kind-defined semantic
    cap.identity <- obj.spec.storage.id             # force per §3
    return cap
  return Unreachable(routes, lastError)
```

Rules:

- `consumer = { agentLocation, agentKind, principal }`. All three may be
  empty; empty matches only routes whose `match` imposes nothing (or whose
  specified fields are all empty in practice — not recommended; see kind
  spec for matching nuances).
- **Order-before-reachability.** Routes are tried in declared order; a
  reachable route lower in the list is used only if all earlier matching
  routes are unreachable. `match`-misses are skipped, not failures.
- **Idempotence at every step.** Re-resolution from the same consumer must
  give a capability equivalent to the first result.
- **No capability may outlive its lease** if the route grants one (matters
  only for future `agent` type).
- **Force `storage.id`.** This is the single mandatory postcondition,
  overriding any id the kind's attach step would naturally mint.

Where resolution is implemented: the *registry service* (`docs/…workspace/spec
T1`) is authoritative for remote consumers; runtimes may implement an
equivalent resolver locally for offline operation, but must produce
byte-identical outputs given the same registry and the same consumer
declaration. Per-consumer resolution is a feature, not an optimization —
two consumers of the same object *should* get different capabilities.

## 7. Versioning and discovery

### 7.1 Version policy

`apiVersion` is a protocol contract. `v1alpha1` allows **adding kinds' spec
fields** and **refining kind-defined semantics**, but does not allow:
removing or renaming protocol fields (envelope, `storage.id`, `owner`,
`match`, `type`, `precondition`); adding route types; changing ordering/
matching semantics; or making `status` meaningful to readers.

A protocol change that breaks any of these = new `apiVersion`. Kind specs
define their own compat within these guards.

### 7.2 Enum policy (kinds)

The five kinds are protocol-fixed. Adding a new kind requires a protocol
version bump; this is deliberately heavy so that namespace sprawl requires
an explicit decision.

### 7.3 Discovery

Consumers learn what the fabric knows about from:
`GET /twill/v1alpha1` → list of objects, **including inert ones**,
with their kinds. Presence in the discovery set does not imply live
behavior — inert objects are listed with a discovered-from flag so
consumers can distinguish "the registry has this" from "the registry can
resolve this."

## 8. Persistence is out of scope (deliberately)

This protocol does not specify storage. The registry's YAML documents are
the source of truth; whether they live in a ConfigMap, a file, or a CRD is
an implementation decision of the registry service (workspace kind spec,
deployment section). The protocol only requires the *shape* of a document
and the *resolution behavior* on it.

## 9. Non-goals (restated in protocol terms)

- Not a workflow engine: no state machines here, no transitions, no leases
  except what route-types carry.
- Not a secret manager: routes reference credential profiles, credentials
  live in consumer-local config or the cluster's sealed secrets.
- Not an agent runtime: capabilities are returned to the caller who uses
  them; the caller's loop is not twill's business.
- Not a delegation protocol: `agent` route is reserved vocabulary; the AWCP
  design inputs live in the workspace kind spec (§7.1 of the rationale doc).

## Appendix A. Terms

- **Capability** — the kind-specific thing a consumer gets on successful
  resolve (for Workspace: an `ExecutionEnv`-shaped fs+shell; other kinds
  define their own).
- **Consumer** — the tuple `{ agentLocation, agentKind, principal }` making a
  resolve request.
- **Delegate / Executor** — for future `agent` routes: the remote agent the
  workspace is leased to (AWCP vocabulary).
- **Inert object** — a well-formed registry document with no current
  behavior; listed in discovery, not resolvable.
- **Reachability** — kind-defined criterion for whether a route's target is
  usable *now*; protocol requires only that it's checked before attach.
