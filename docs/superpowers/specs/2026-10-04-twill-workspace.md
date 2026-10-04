# Twill — Workspace kind spec

**Status:** Draft (revision 2, after dual review + party-model redesign)
**Date:** 2026-10-04
**Inherits:** `2026-10-04-twill-fabric-core.md` (revision 3, authoritative).
This document may instantiate that protocol; it does not restate or redefine
it. Disagreements resolve in core's favor.
**Scope:** the `Workspace` kind — schema, route types, preconditions,
adapters, the registry service's concrete transport and deployment.

---

## 1. The party model (read this first)

The strongest two rounds of review converge on one conclusion: a naive
"registry resolves and attaches" spec is unimplementable (the registry can't
serialize a live capability, the registry can't reach a workstation `local`
route), so everything falls apart on who does what. The fix is to name the
three parties explicitly:

- **Registry** — the *yellow pages*. It knows what exists and, given a
  consumer, *selects the route* that should apply. It does not precondition,
  does not attach, does not even know whether a given route is currently
  reachable in the provider reality vs. in its documents. Like the phone
  book, it hands you the number; it doesn't call the plumber for you.
- **Provider** — the side that *owns and materializes* the physical storage
  a workspace lives on. Providers *register* workspaces with the registry,
  run the preconditions that make storage ready, and report the current
  state of a workspace to the registry on request (or on events). This is
  the critical design rule: materializing a workspace is the provider's
  business. A git-clone precondition belongs to the provider that owns the
  repository — if the consumer had to run `gitClone` to use the capability,
  the "provider" is only leasing raw filesystem, not a workspace.
- **Consumer** — the agent/runtime that resolves and then *opens the
  capability* against the provider. Consumers only ever talk to the
  registry until the last moment, when they use the returned route to attach
  and do work.

Resolution is thus split cleanly across the parties:

```
   consumer                     registry                       provider
      │                            │                              │
      │  POST /resolve             │                              │
      │ (kind, name, consumer)     │                              │
      ├───────────────────────────►│                              │
      │                            │  matches routes for consumer │
      │                            ├─────────────────────────────►│
      │                            │  reported state              │ (probes)
      │                            │◄─────────────────────────────┤
      │◄───────────────────────────┤                              │
      │  Attached(route descriptor │  (see §5 for payload)        │
      │   incl. route + identity   │                              │
      │   + reported state)        │                              │
      │                            │                              │
      │  adapter.attach(route)     │                              │
      ├────────────────────────────┼─────────────────────────────►│  (direct route
      │                            │                              │   mechanism:
      │                            │                              │   local / ssh /
      │                            │                              │   k8s-exec)
```

The provider owning preconditions is the point: materialization is *the
product* the provider provides; the condition "the repo is cloned" is part
of the provided workspace itself, not a side channel the consumer rebuilds.
(See §4 for why this is what makes the workplace-scale story close.)

## 2. Workspace schema (v1alpha1)

Conforms to the fabric-core envelope (§2): top-level `spec.` is exactly
`owner`, `routes`, `workspace`. Instantiates the kind spec object:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: workstation-repos, labels: { twill/workspace-class: git } }
spec:
  owner: user:example          # <scheme>:<id>, self-declared, untrusted in v1alpha1
  routes: []                          # §3
  workspace:
    storageBacked: true                # fabric-core §2.2 declaration — Workspace IS storage-backed
    accessMode: RWO                    # RWO | RWX; see §2.1
    storage:
      id: ws_01J8Z4-workstation-repos  # durable id; required; immutable under rename
      fingerprint: vol-2c4f1a          # REQUIRED, content-stable identifier (see below)
    hostname: workstation              # display-only
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full | readonly | none
status: {}                             # controller-owned in v2, readers treat as opaque
```

`storageBacked: true` declares the invariant surfaces (fabric-core §2.2).
`storage.id` identifies the physical bytes; two Workspace objects over the
same bytes MUST share it (fabric-core §3 — the rule and its load-reject
contract live there, not here). The kind-owned decision this spec makes is
the **fingerprint value vocabulary** for Workspace: a comparable, content-
stable identifier of the *physical backing*: a volume UUID / LVM / filesystem
UUID for local-backed workspaces, a PVC UID for k8s-exec-backed workspaces,
the workstation's machine-id for ssh-backed workspaces. (The machine-id is
content-stable across reinstalls of the same host; reinstall wipes change
what the fingerprint *means*, which is the right behavior — the bytes are
gone.) Registries reject a document set where populated fingerprints pair
with different `storage.id`s (core §3).

### 2.1 accessMode: RWO vs RWX

`storageBacked` kinds need to say how many concurrent consumers the storage
supports correctly. `accessMode: RWO | RWX` declares that:

- `RWO` — single concurrent consumer (analogy: iSCSI, RWO PVC). A second
  consumer attaching while the workspace is in use may corrupt writes; the
  consumer-facing rule is *only one active capability per `storage.id` at a
  time*. The provider reports `state` and the consumer is expected to
  release = relinquish (v2 leases formalize "release").
- `RWX` — many concurrent consumers (analogy: NFS, RWX PVC). Concurrent
  capabilities against one `storage.id` are supported; correctness is
  mediated by the storage layer (POSIX semantics, lockfiles), not the
  fabric.

v1alpha1 does not *enforce* concurrency; the workspace kind kind spec
declares it, the provider reports it in `statusReport`, adapters and UIs may
warn. Lease/enforcement machinery is card/AgentProfile v2 territory.

The default is `RWO`. `accessMode` is kind-owned; other kinds (Card) have
no analogue because they aren't storage-backed.

## 3. Route types (the Workspace enum)

The Workspace kind's route-type vocabulary (fabric-core §5.2):

| `type` | Mechanism | Kind-required fields | v1alpha1? |
|---|---|---|---|
| `local` | Direct filesystem + shell | `path` | yes |
| `ssh` | SSH exec + SFTP | `address`, `path` | yes |
| `k8s-exec` | `kubectl exec` + PVC | `pvc`, `path` — NOT a pod name (see §3.1) | yes |

These are owned by this kind spec; the protocol knows nothing about them.
`agent` is not a v1alpha1 route type — the delegation design it gestured at
is a v2 sketch (Appendix A; composite rationale §7.1).

Route fields beyond `type`/`match`/`precondition` are kind-defined (`path`,
`address`, `pvc`); the three envelope names are reserved (core §5.1). A
route carrying an unknown extra field is a spec violation the loader
rejects; a route missing a required field for its type is likewise invalid
(discovery marks the object `resolvable: false`).

### 3.1 Why `k8s-exec` identifies a PVC, not a pod

A pod name is ephemeral and so unstable for a registry document. The
Workspace `k8s-exec` route names the PVC; the *mechanism* of reaching the
bytes (which pod mounts them) is adapter-side and convention-driven (for
v1alpha1 the convention is `pvcBind`-produced pod, `twill-ws-<storage.id>-
consumer>` selector). A pod reference is the mechanism; the PVC is the
target.

## 4. Precondition steps (provider-owned)

Preconditions are the provider's materialization machinery:
`precondition: { steps: [...] }` at the route envelope; ordered, idempotent,
short-circuit on failure (core §5.3). Execution context: steps execute in
the **provider's** environment against the route target, with ambient
provider credentials (core §9: route credential references are pointers,
not bytes). The Workspace kind's step-type vocabulary:

| Step `type` | Fields | Semantics |
|---|---|---|
| `gitClone` | `{url, ref, credentials?}` | Ensure a clone of `url` at `ref` exists at the route's `path`. Idempotent: no-op if `path` is a worktree whose remote-tracking ref matches; *fast-forward if `HEAD` is ancestor-of-`ref` and the tree is clean*; FAIL on dirty/diverged (never silently attach against stale or wrong content). |
| `worktree` | `{repo, branch, base?}` | Ensure a worktree of `repo` exists at `path` on `branch`. Create branch+worktree if absent; re-resolve = no-op if same branch/commit; FAIL if `branch` is checked out in a different worktree or the worktree exists at a different commit. |
| `pvcBind` | `{name, namespace, timeout?}` | Ensure PVC `name` in `namespace` is Bound; wait up to `timeout` (default 120s) for binding. Execution context: in the provider's cluster context. |
| `remoteMkdir` | `{}` | Ensure the route's `path` exists (with parents). Execution context: in the provider's shell on the route's machine (e.g. ssh to `address` for an `ssh` route). |
| `mountCheck` | `{device | fstype}` | Verify `path` is on the named device/fstype before attach. Execution context: the provider's shell. |

**Concurrent preconditioning and leases:** the *execution* of a
precondition is guarded by the workspace's claim/claim machinery where it
lands (Card/AgentProfile v2). In v1alpha1, providers are expected to be
idempotent all the way down and consumers are expected to be cooperative.

**Multi-step ordering example** (rationale for the list shape): the
natural form of "work on a new branch of a repo" is `[gitClone, worktree]`;
the natural form of "materialize a k8s workspace on cold storage" is
`[pvcBind, gitClone, mountCheck]`.

## 5. Resolution and the route descriptor

`resolve(Workspace, name, consumer)` is the registry's *selection*
operation (party model, §1). Concretely:

```
POST /twill/v1alpha1/resolve
  { kind: Workspace, name: "workstation-repos",
    consumer: { agentLocation: "cluster", agentKind: "pi", principal: "" } }
→ 200 Attached:
    { kind: Workspace, name: "workstation-repos",
      durable_id: "ws_01J8Z4-workstation-repos",
      identity:   "ws_01J8Z4-workstation-repos",       # = durable_id; the forced cap.identity
      route: {match, type, address, path, precondition},  # the selected route, verbatim
      status:    { state, attachedBy?, detail? }       # provider-reported (§6.2)
    }
→ 200 NoMatch:      { kind, name, consumer }
→ 503 Unreachable:  { kind, name, perRouteErrors: [ {route, reason} ] }
```

Selection proceeds per fabric-core §6 exactly, with these Workspace-kind
clarifications: matching is core §6.1 exact-string-equality; NoMatch is
"no route selected this consumer"; Unreachable is "at least one candidate
failed the provider-reported state check" with per-route reasons. The
registry **does not decide** state. It queries the provider (§6.2) and
**forwards** the result. A route whose provider reports `state: down` or
fails to report at all after timeout is per-route Unreachable, not a
registry-side lie about reachability.

`status` in the response is the provider's *reported* view of the
workspace — whatever the provider said on its last statusReport or the
result of the registry's status query — **not** a registry-side truth.
Adapters treat it as advisory (a consumer may still fail to attach against
a reported-"ready" workspace).

`identity` in the response is what the adapter MUST stamp onto whatever
capability it then mints. For Workspace it equals `durable_id` ==
`spec.workspace.storage.id`; the separate field exists to keep the wire
shape uniform across kinds (a future non-storage-backed kind reports its
own durable-id path here).

## 6. The provider and its status report

### 6.1 Provider registration

A provider is an implementation hook per route type per place-not-yet-
standard. v1alpha1 defines registration by software convention rather
than a full provider-discovery protocol: the registry is *configured* (its
own YAML) with the set of providers it knows how to contact for
statusReport and the addressing gramar for each. A fuller provider
discovery/gossip is v2.

### 6.2 `Workspace.statusReport`

The machine-readable reporting shape (what the provider answers when the
registry asks; the registry caches it so answers don't stall at a dead
provider):

```json
{
  "kind": "Workspace",
  "name": "workstation-repos",
  "storage.id": "ws_01J8Z4-...",
  "state": "provisioning | ready | degraded | down",
  "attachedBy": [ {consumer} ],           # optional, advisory
  "detail": "<free text>",
  "asOf": "<rfc3339>"
}
```

The registry also accepts **push** updates (`POST
/twill/v1alpha1/<kind>/<name>/statusReport`, provider-token-authenticated
deployment-side) for providers that want to push events rather than
answer polls; both shapes go through the same JSON shape above.

The provider is expected to update `state` as its provisioning completes;
a *materialized* workspace is one whose last-reported `state` is `ready`.

### 6.3 Failure surfaces at the registry, concretely

- The registry-loader applies fabric-core §3's document-set reject on every
  (re)load of the watched document set, not only at startup: a reload that
  introduces a populated-fingerprint `storage.id` conflict rejects the
  reload, the registry keeps serving the **last-good document set**, and
  it reports the rejection via its own health surface (a `state: degraded`
  internal + log line is the v1 contract; a `/healthz` endpoint would be
  added when the deployment work lands). This rule exists so single-replica
  availability survives a bad ConfigMap edit.
- Missing required route field / unknown route field on a document → the
  document is rejected at load; the registry serves the last-good set
  (same rule).

### 6.4 What the registry does *not* do

- Does not execute preconditions.
- Does not mint or attach capabilities.
- Does not authorize access (matching selects configuration; authorization
  is explicitly out of scope in v1alpha1).

## 7. Consumers and adapters (WorkspaceEnv)

The capability an adapter mints after a successful resolution is a
WorkspaceEnv. An adapter for a runtime uses the runtime's native workspace
shape when it has one, and WorkspaceEnv otherwise:

```
WorkspaceEnv :: {
  FileSystem    # read/write/list ops, adapter picks the mapping per runtime
  Shell         # command execution in the workspace's cwd context
  id            # = spec.workspace.storage.id (forced; identity slot)
  cwd           # the workspace's root for this capability (= route.path
                # after preconditions satisfied)
}
```

Adapter per-runtime mapping is idiomatic, not a shim: pi's `ExecutionEnv`
is the natural target because its `{FileSystem, Shell, id}` contract is the
field the ecosystem already solves; hermes' terminal backends get a
`twill` backend module; opencode gets a config generator; cursor maps
`precondition` onto `worktrees.json`. (Composite rationale §6 has the full
comparison table.) The **adapter** is the actor responsible for forcing
`id` — core §3 already says so, this section merely names the adaptation
point.

`attach` happens *in the adapter* after resolution returns the route
descriptor. The adapter is also the right place for any consumer-local
readiness checks it wants to run before doing work (not required —
the registry's reported state is advisory, so a consumer may attach
eagerly).

Where a runtime has no durable-id slot (pure-config consumers like
opencode), the adapter pins the value in generated config (e.g. a label in
opencode's project file), which preserves the cross-runtime serialization
guarantee through adapter-generated config too.

## 8. Deployment

- **In-cluster (primary):** Deployment + PVC (`itty-nfs-flashy`, 4Gi),
  ClusterIP Service for in-cluster consumers, Tailscale LoadBalancer
  Service (`twill.tailnet.example.test`) for workstation consumers.
  Documents from a ConfigMap; the chart lives in the helm-charts repo
  (same repo as the other example charts). Single replica.
- **Not-in-cluster:** docker-compose with a bind-mount for the YAML
  documents; identical behavior.
- **No operator in v1alpha1;** `status:` stays empty.

## 9. Milestones

- **T1 (1–2 days):** registry process + `POST /resolve` + document watch +
  `GET /twill/v1alpha1` discovery + `Workspace.statusReport` push/pull +
  fingerprint load-reject + Workspace kind only. First consumer: the
  `twill` CLI making HTTP calls (it prints the route descriptor; it is not
  a second resolver).
- **T2 (2–3 days):** pi adapter (`twill-pi` extension) — local + ssh routes
  + provider-driven preconditions on those routes; reference implementation.
- **T3 (2 days):** k8s-exec route + the remaining step types
  (`pvcBind`, `remoteMkdir`, `mountCheck`).
- **T4 (1 day):** hermes terminal-backend `twill` (sigrun consumer).
- **T5 (deferred):** Card/skuld per holding note; MCPServer/Skill/
  AgentProfile kinds via their own specs; `status:` controller; Authelia
  OIDC; provider discovery/gossip.

## Appendix A. v2 sketch — the `agent` route type

(Reserved design space: a route `type: agent` realizing AWCP-style
workspace *delegation* — lease-bounded, executor selector, snapshot vs
live-sync declaration. References composite rationale §7.1 and the fabric
core's protocol-reserved route-type policy; not to be implemented from
this spec.)
