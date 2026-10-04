# Twill fabric core — the protocol

**Status:** Draft (revision 2, post-review)
**Date:** 2026-10-04
**Scope:** The **agent-agnostic workspace fabric protocol only**. Nothing in this
document is runnable. Every kind-specific spec (workspace, card, mcp, skill,
agentprofile) **inherits this document and may not restate or redefine it**;
disagreements resolve in this document's favor. This document is
**authoritative** for the fabric protocol: where any sibling doc conflicts,
this wins; kind specs may instantiate it but not redefine it.
**Sibling rationale doc:** `2026-10-02-twill-fabric.md` (what each kind is for,
why the fabric exists, neighboring tools).

---

## 1. Purpose

Twill is a typed directory of fabric objects that agent runtimes **resolve**
into capabilities they can use. Five object kinds exist; only `Workspace` is
built in v1alpha1. This document specifies the **invariants every kind and
every consumer shares** — the envelope, the identity rules, matching, the
resolution algorithm — so that kind-specific specs stay small and so that
adapters for one kind need know nothing about another kind.

The single question this protocol answers:

> Given a **kind**, a **name**, and a **consumer**, how does the consumer get
> a usable capability, and how is it prevented from silently colliding with
> another consumer of the same physical resource?

## 2. The envelope

Every fabric object is one YAML document in the following CRD-forward shape.
The envelope is protocol-fixed; kinds may not alter it:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1     # required; version rules in §7
kind: Workspace | Card | MCPServer | Skill | AgentProfile
metadata:
  name: <string>          # unique within this kind
  labels: {<class keys>}  # optional
spec:
  owner: <subject>        # REQUIRED — §4
  routes: [<route>]       # ordered, may be empty — §5
  <kindname>: { ... }     # the kind's spec object; name = lowercase kind — §2.2
status: {}                # reserved; controller-owned in v2, reader-ignored
```

Protocol rules on the envelope:

- **`spec.` top level carries exactly four keys:** `owner`, `routes`,
  `<kindname>`, and nothing else. All kind-specific data lives under
  `spec.<kindname>`. This is the mechanically-decidable line between protocol
  fields (which require a version bump to add) and kind fields (which don't).
- `apiVersion` is protocol-owned; version rules in §7.1.
- `kind` is one of the five values above; adding kinds is a protocol version
  bump (§7.2).
- `metadata.name` is unique within a kind; there is no cross-kind uniqueness.
- `status` is structurally reserved: readers must treat it as opaque, writers
  in v1alpha1 must leave it empty. Readers must not require it to exist. (The
  composite's "absent in v1" phrasing means the same rule, restated; this
  wording is the operative one.)
- A document may be **inert**: well-formed but with no resolvable behavior
  yet (`§7.3`). Inert documents are valid fabric input.

### 2.1 The kind spec object (`spec.<kindname>`)

The lowercase kind name is the name of the kind's spec object: a Workspace
document has `spec.workspace`, a Card has `spec.card`, an MCPServer has
`spec.mcpserver`, a Skill has `spec.skill`, an AgentProfile has
`spec.agentprofile`. The kind spec owns everything under it: its own durable
id (§3), its route-type vocabulary (§5.2), its route-envelope elaborations,
its matching-relevant semantics, its own fields.

This rule is what lets new kinds land without touching the protocol: the
protocol knows where to find `spec.<kindname>`; it does not know or care
what's inside.

### 2.2 Durable id (per kind)

Every kind MUST designate a **durable id field** at a protocol-fixed path
under `spec.<kindname>`:

- **Storage-backed kinds** (§3): `spec.<kindname>.storage.id`
  (e.g. a Workspace's `spec.workspace.storage.id`)
- **All other kinds**: `spec.<kindname>.id`
  (e.g. a Skill's `spec.skill.id`, an AgentProfile's `spec.agentprofile.id`)

The durable id is minted once at object creation, immutable under rename,
and never recycled. The protocol requires its existence and immutability;
the kind spec assigns the value and states what the id identifies. Identity
is a cross-kind protocol requirement even though the *write serialization*
refinement (§3) applies only to storage-backed kinds: a Skill has a
`skill.id` identifying the skill even though no two consumers can corrupt
each other through it.

## 3. Storage-backed kinds and the write-serialization invariant

For **storage-backed kinds** (Workspace only, in v1alpha1), the durable id
is `spec.<kindname>.storage.id` and has an additional meaning beyond identity:

> **`storage.id` is the identifier a consumer uses to serialize writes
> against the physical resource the object resolves to.**

Rules specific to storage-backed kinds:

- **Physical-resource semantics.** If two objects' routes can ever resolve to
  the same physical bytes, those objects **MUST declare the same
  `storage.id`**. Minting a fresh id per object when two objects alias one
  backing store defeats write serialization — this is the correctness bug
  the field exists to prevent.
- **Author-assigned, not protocol-generated.** The author of the registry
  document is responsible for assigning `storage.id` correctly; two documents
  over one volume share the value by authorial intent, not by any automated
  dedupe.
- **Adapter responsibility.** A capability minted from a storage-backed
  object MUST carry that object's `storage.id` in a protocol-reserved
  identity slot (`cap.identity`). The **adapter** is the responsible actor;
  runtimes without a native id concept inherit the value verbatim (runtimes
  that never run a resolver get the id from the adapter's generated config).
- **Immutability under rename.** Renaming `metadata.name` must not change
  `storage.id`.
- `spec.<kindname>.storage.fingerprint` (optional) is an out-of-band
  verifier (volume UUID, machine-id, content hash); advisory in v1alpha1,
  the v2 hook for controller-verified identity.

Non-storage-backed kinds (Card, MCPServer, Skill, AgentProfile in v1alpha1)
have no aliasing hazard: two Skill documents naming the same skill are
duplicates, not a serialization conflict. Their durable ids are identifiers,
not correct-serialization guards.

## 4. Owner and principal

Every object has **one** `spec.owner`, a subject string in the grammar
`<scheme>:<id>` (e.g. `user:example`, `team:platform`). Required even
for single-user deployments — day-one access-control hook; omitting it in
v1alpha1 forces a migration later. v1alpha1 consumers may ignore it for
access decisions but must preserve it in documents they create or mutate.

A **principal** is the request-side claim of identity. `spec.owner` is the
registry-side claim. The protocol keeps them separate so a v2 controller can
bind them. **Routes are not an authorization boundary**: `principal` is
self-declared in v1alpha1 and must be treated as untrusted; matching on
`principal` selects configuration but does not enforce access.

## 5. Routes

A route is one object inside `spec.routes[]`. Routes are **per-consumer
resolvers**: the same object yields different capabilities to different
consumers.

### 5.1 Route envelope (protocol-fixed)

```yaml
- match: {agentLocation: <string>, agentKind: <string>, principal: <string>}   # any subset; omitted = match all
  type: <string>                          # route type; kind-defined enum — §5.2
  precondition: { steps: [ ... ] }        # optional, ordered — §5.3
  # (kind-defined route fields follow, under the same route object)
```

The protocol fixes only the envelope keys: `match`, `type`, `precondition`.
Every other key on a route object is kind-defined. `match` is optional;
`match: {}` and absent `match` both mean "matches every consumer." Unknown
keys inside `match` are a spec violation (matching keys are closed by §5.1).

### 5.2 Route `type` value

The `type` value is a string. **The set of valid route types is owned by the
kind spec, not by the protocol.** The protocol does not enumerate
`local`/`ssh`/`k8s-exec`/`agent` — those are the Workspace kind's types.
Kinds may define whatever route types are meaningful for their abstraction
(an MCPServer kind's types will likely differ from a Workspace's), and
onboarding a new kind never requires a protocol version bump because its
vocabulary is unfamiliar.

A convention, not a rule: kinds whose routes concern the same physical
mechanisms SHOULD reuse the same route-type names (a future kind with a
filesystem route should call it `local`, not `direct`), so the fabric reads
coherently across kinds.

### 5.3 `precondition.steps[]`

A route may declare `precondition`: an **ordered list** of provisioning steps
the resolver runs *before* attaching the capability. Each step is an object
with a kind-defined `type` and kind-defined fields. Steps execute in order;
**any step's failure makes the route unusable** (the resolver moves to the
next route; `§6`). Preconditions MUST be idempotent — re-resolving an
already-resolved route must not re-do provisioning destructively.

Typical step `type` vocabulary (`gitClone`, `worktree`, `pvcBind`,
`remoteMkdir`, `mountCheck`) is owned by the Workspace kind spec.

## 6. Resolution and matching

Resolution maps `(kind, objectName, consumer)` to exactly one of three
results: an **attached capability**, `NoMatch`, or `Unreachable`.
Implementations MUST conform to this algorithm:

```
resolve(kind, objectName, consumer) -> Attached | NoMatch | Unreachable:
  obj    <- registry.get(kind, objectName)
  routes <- obj.spec.routes.filter(matches(r.match, consumer))   # §6.1
  if routes is empty: return NoMatch(obj, consumer)
  errors <- []
  for r in routes (in declared order):
    if not reachable(r):                                    # kind-defined probe
      errors.append((r, "unreachable")); continue
    for step in (r.precondition?.steps ?? []):              # §5.3
      if step fails:
        errors.append((r, "precondition failed")); continue outer
    cap  <- kind.attach(r)                                  # kind-defined
    cap.identity <- obj's write-serialization identity      # forced, §3:
                 #   storage.id for storage-backed kinds;
                 #   the durable id otherwise
    return Attached(cap)
  return Unreachable(obj, consumer, errors)
```

Rules:

- **Three distinct results.** `NoMatch` = no route's `match` selected this
  consumer (configuration intent, not failure). `Unreachable` = at least one
  route matched but none survived reachability/precondition. UIs and agents
  must be able to tell these apart: NoMatch is "nothing is for you,"
  Unreachable is "something is for you and it's not working."
- **Per-route errors in `Unreachable`.** The result carries
  `(route, reason)` pairs in attempted order, so callers can tell whether the
  whole set failed or only higher-priority routes did.
- **Order before reachability.** A reachable route lower in the list is used
  only if every earlier matching route was genuinely unusable (unreachable,
  failed precondition). Matching is not a health check.
- **Identity postcondition.** Whatever `kind.attach` would naturally mint as
  the capability's identity, the forced assignment above wins. This is the
  mechanism D1/D3 make enforceable.
- **Resolver portability.** The *registry service* is authoritative for
  remote consumers; a runtime may implement a local resolver for offline
  operation. Multiple resolvers against the same registry documents and the
  same consumer declaration MUST produce the same route selection and the
  same capability identity. Live capability state (ssh connections, FUSE
  mounts) will obviously differ and is not part of the conformance rule.
- Per-consumer resolution is a feature: two consumers of the same object
  SHOULD expect different capabilities.

### 6.1 Matching semantics

Matching between a route's `match` and a consumer is **exact string equality
on every key `match` specifies**; the consumer's declaration supplies
`agentLocation`, `agentKind`, `principal` (each a string, each required on
the consumer, each possibly empty). A route matches iff every key it lists
equals the consumer's value for that key; absent keys match anything. No
wildcards, no case folding, no regexes, no version-suffix rules.

**Guidance (non-normative):** versioned `agentKind` values in routes
(`pi/0.99.1`) are a footgun — any version bump un-matches existing routes.
Match on the runtime family (`pi`, `hermes`) unless a route genuinely needs
to discriminate by version, and document the version grammar in the kind
spec if it does.

## 7. Versioning and discovery

### 7.1 Version policy

`apiVersion: twill.bitwiseoperations.ca/v1alpha1` permits, without a markdown bump:
adding fields inside `spec.<kindname>`; adding or refining kind-defined
route types; refining kind-specific matching-relevant semantics where the
protocol leaves them open. v1alpha1 does **not** permit:
adding/removing/renaming any of the four `spec.`-top-level keys; adding
consumer dimensions to the match selector; changing matching semantics;
renaming the durable-id path rule; making `status` meaningful to readers.

Any such change is a new `apiVersion`. (This makes the kind/protocol
boundary mechanically decidable: if a field is not one of the four
envelope keys and sits under `spec.<kindname>`, it is kind-owned.)

### 7.2 Enum policy (kinds)

The five v1alpha1 kinds are protocol-fixed. Adding a new kind is a protocol
version bump — deliberately heavy so namespace sprawl requires an explicit
decision. (Kind-defined route types and kind spec fields do not trigger
this.)

### 7.3 Discovery

Discovery is the capability to list what a registry knows about. The
protocol fixes the *abstract shape*: a **list of object references**, where
each entry is:

```
{ kind: <string>, name: <string>, durable_id: <string|null>, resolvable: bool }
```

Rules:
- `resolvable` is a **per-object, registry-side** boolean (not per-consumer):
  `true` iff the object's kind has a registered kind-runner in the serving
  process AND `spec.routes` is non-empty. Cards in a registry with no card
  service are inert, so they appear with `resolvable: false` — exactly the
  "list them, don't pretend to resolve them" rule from the Card holding note.
- Discovery lists **every object the registry holds, inert included**.
- The concrete transport for discovery (HTTP, file walk, CLI output) is
  **not** core-protocol business; that shape belongs to the registry-service
  spec (in the workspace kind spec, deployment section). This document fixes
  only the abstract list-of-references shape.

## 8. Persistence and transport are out of scope (deliberately)

This protocol does not specify how documents are stored or served. The
registry's YAML documents are the source of truth; whether they live in a
ConfigMap, a file tree, or a CRD is the registry service's implementation
decision (workspace kind spec). The protocol only requires the *shape* of a
document, the *resolution behavior*, and the *discovery shape* above.

## 9. Non-goals (restated in protocol terms)

- Not a workflow engine: no state machines here, no transitions.
- Not a secret manager: route credential references are pointers; bytes live
  in consumer-local config or sealed secrets.
- Not an agent runtime: capabilities are returned to the caller, whose loop
  is its own business.
- Not a delegation protocol: `agent` route types (when a kind spec defines
  one) are elaborations of that kind, not core vocabulary. The AWCP design
  inputs (arXiv 2602.20493) live in the workspace kind spec's §7.1.

## Appendix A. Terms

- **Capability** — the kind-specific thing a consumer gets on successful
  resolve (for a Workspace, an ExecutionEnv-shaped fs+shell).
- **Consumer** — the tuple `{ agentLocation, agentKind, principal }` making a
  resolve request; self-declared, untrusted in v1alpha1.
- **Durable id** — each kind's `<kindname>.id` under `spec.<kindname>`;
  existence+immutability required by protocol, semantics kind-defined.
- **Inert object** — a well-formed document with no resolvable behavior
  (`resolvable: false` in discovery).
- **Reachability** — kind-defined probe whether a route's target is usable
  now; protocol requires only that it gates attach.
- **Storage-backed kind** — a kind whose durable id is
  `spec.<kindname>.storage.id` and carries the write-serialization invariant
  of §3 (v1alpha1: Workspace only).
