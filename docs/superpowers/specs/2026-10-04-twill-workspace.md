# Twill — Workspace kind spec

**Status:** Draft
**Date:** 2026-10-04
**Inherits:** `2026-10-04-twill-fabric-core.md` (revision 3+, authoritative).
This document may instantiate that protocol; it may not restate or redefine
it. Disagreements resolve in core's favor.
**Scope:** the `Workspace` kind — schema, route types, preconditions, adapters,
the registry service's concrete transport and deployment. **Not** cards, not
dispatch, not the assistant (that's `sigrun`).

---

## 1. What this kind is

`Workspace` is the storage-backed kind the fabric exists to carry: a named
execution/storage context (a directory tree, an SSH host, a k8s pod/PVC) that
agents resolve into fs+shell capabilities for their own location. v1alpha1
builds this kind only; the other four kinds are reserved (Card is
schema-pinned but implementation-deferred).

The Workspace answer to the fabric's one question is:

> Given `resolve(Workspace, name, consumer)`, mint the capability
> (`ExecutionEnv`-shaped, or each runtime's nearest equivalent) the consumer
> can use against the shared bytes, with `cap.identity` forced to
> `spec.workspace.storage.id`.

## 2. Workspace schema (v1alpha1)

Conforms to the fabric-core envelope (§2): top-level `spec.` is exactly
`owner`, `routes`, `workspace`. Instantiates the kind spec object:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: workstation-repos, labels: { twill/workspace-class: git } }
spec:
  owner: user:example          # <scheme>:<id>
  routes: []                          # §3
  workspace:
    storageBacked: true                # §2.2 declaration — Workspace IS storage-backed
    storage:
      id: ws_01J8Z4-workstation-repos  # durable id; required; immutable under rename
      fingerprint: <required>          # REQUIRED on storage-backed kinds (fabric-core §3)
    hostname: workstation              # optional display/metadata
    toolHints: [git, forgejo-api, pi]  # adapter-visible hints
    shellPolicy: full | readonly | none
status: {}                             # controller-owned in v2, readers treat as opaque
```

`storageBacked: true` is the declaration (fabric-core §2.2): Workspace is
v1alpha1's sole storage-backed kind because two Workspace objects can alias
one volume. `storage.fingerprint` is REQUIRED — populated by the author with
a comparable identifier of the backing resource (e.g. volume UUID,
machine-id of the workstation, PVC UID); the registry rejects the document
set at load if any two Workspace documents share a non-empty fingerprint
with different `storage.id`s.

## 3. Route types (the Workspace enum)

The Workspace kind's route-type vocabulary (fabric-core §5.2):

| `type` | Mechanism | Kind-required fields | v1alpha1? |
|---|---|---|---|
| `local` | Direct filesystem + shell | `path` | yes |
| `ssh` | SSH exec + SFTP | `address`, `path` | yes |
| `k8s-exec` | `kubectl exec` + PVC | `address` (pod), `pvc`, `path` | yes |

`local`/`ssh`/`k8s-exec` are names owned by this kind spec — the protocol
knows nothing about them. The `agent` type from earlier drafts is **not** a
v1alpha1 route type; the delegation idea it gestured at lives as a v2 design
sketch informed by AWCP §7.1 (see composite rationale, `2026-10-02`, §7.1).

Route fields beyond `type`/`match`/`precondition` are kind-defined (`path`,
`address`, `pvc`, `lease`, `mountpoint`, etc.); the three envelope keys are
reserved (fabric-core §5.1).

## 4. Precondition steps

Precondition is an ordered list at the route envelope:
`precondition: { steps: [ ... ] }`. Each step has a kind-defined `type` and
fields. All steps are idempotent; re-resolve = no destructive re-setup.
 Failure of any step marks the route unusable and resolution continues
(fabric-core §5.3, §6).

The Workspace kind's step-type vocabulary:

| Step `type` | Meaning |
|---|---|
| `gitClone` | Ensure a clone of `{url, ref}` exists at the route's `path`. No-op if already cloned at ref; fast-forward if behind; otherwise no-op. |
| `worktree` | Ensure a worktree of `{repo}` exists at the route's `path` on `{branch}`. Creates the branch+worktree if absent. |
| `pvcBind` | Ensure PVC `{name}` is bound in `{namespace}`; wait until bound. |
| `remoteMkdir` | Ensure the route's `path` exists (with parents). |
| `mountCheck` | Verify the route's `path` is on the expected device/fs (feature probe). |

Multi-step preconditions are ordered and short-circuit on first failure.

## 5. Resolution (what the Workspace kind adds)

Resolution is `resolve(Workspace, name, consumer)` against fabric-core §6.
Workspace's reachability rule: a route is *reachable* if its mechanism is
currently executable from the resolver's environment (local: fs access;
ssh: handshake; k8s-exec: kubectl token + pod exists). The kind does not
define matching beyond core's exact-string-equality rule, and does not add
consumer dimensions.

Workspace's `kind.attach(r)` returns a **WorkspaceEnv** — an
`ExecutionEnv`-shaped capability: `{ FileSystem, Shell, id }` where `id`
is forced to `spec.workspace.storage.id` on return (fabric-core §6 identity
postcondition). Everything after minting is adapter-owned.

## 6. The registry service

The registry service is v1alpha1's attached-process surface for resolution
and discovery. (The fabric core owns the *abstract* shapes; this section
fixes the concrete ones.)

- **Processes:** one registry process, config-file-backed (watched YAML
  documents = the fabric DB), single replica.
- **Exposes (concrete HTTP; workspace-kind spec owns this shape):**
  - `GET  /twill/v1alpha1` → `[ {kind, name, durable_id, resolvable} ]`
    — the discovery set, inert objects included as `resolvable:false`.
  - `GET  /twill/v1alpha1/<kind>/<name>` → the document.
  - `POST /twill/v1alpha1/resolve` →
    `{ kind, name, consumer }` → `Attached | NoMatch | Unreachable` payload,
    with per-route errors on Unreachable.
  - `PATCH /twill/v1alpha1/<kind>/<name>` — registry-author edits (v1-alpha;
    auth is deployment-side).
- **Sources:** YAML documents from a mounted ConfigMap (in-cluster) or
  bind-mount (docker-compose).
- **Auth:** v1 deployment-shaped (Tailnet-only service, Authelia ExternalAuth
  optional, or token header). `principal` is self-declared; routes are not an
  authorization boundary (fabric-core §4).
- **Load-time contract:** at startup, the registry MUST reject the document set
  if any two Workspace documents share a non-empty `storage.fingerprint`
  with different `storage.id`s (fabric-core §3).

The above is Workspace-kind business, not core protocol. A local resolver
(CLI mode) must produce the same route selection and the same `cap.identity`
given the same documents and the same consumer declaration (fabric-core §6
portability, qualified by reachability observations).

## 7. Adapters

Adapters instantiate a WorkspaceEnv for specific runtimes. All adapters
resolve against the registry (or local YAML in offline mode), force
`cap.identity` per core §3, and invoke preconditions.

| Runtime | Adapter | Mechanism |
|---|---|---|
| **pi / pi-durable** | `twill-pi` pi extension (reference, ~200 lines) | resolve → `ExecutionEnv` directly; v1 routes `local` and `ssh` |
| **hermes** | terminal-backend module named `twill` | resolve → hermes terminal backend; same shape as hermes' `local`/`docker`/`ssh`/`sshd` backends |
| **opencode** | config generator | emits opencode's static per-project config from the registry |
| **cursor** | provisioning-hook adapter | maps `precondition` onto `.cursor/worktrees.json` |
| **claude code** | attach-only | local-only; remote handled upstream |
| **openclaw** | attach-only or generator | per gateway-workspace-dir conventions |

Pi's is the reference because `ExecutionEnv` is the cleanest contract in the
field; it surfaces protocol mistakes first. Hermes's and opencode's are the
next priority (sigrun, the harness consumer).

## 8. Deployment

- **In-cluster (primary):** Deployment + PVC (`itty-nfs-flashy`, 4Gi),
  ClusterIP Service for in-cluster consumers, Tailscale LoadBalancer Service
  `twill.tailnet.example.test` for workstation consumers. Documents from a
  ConfigMap. Single replica (RWO PVC + Recreate).
- **Not-in-cluster:** docker-compose with a bind-mount for the YAML
  documents; identical registry behavior.
- **No operator in v1alpha1;** `status:` stays empty.

## 9. Milestones

- **T1 (1–2 days):** registry process + resolve endpoint + YAML watch +
  discovery endpoint + Workspace kind only. First consumer: a small `twill`
  CLI (`twill resolve workstation-repos` for both a `workstation` and a
  `cluster` consumer).
- **T2 (2–3 days):** pi adapter (`twill-pi` extension) — local + ssh routes
  + preconditions; reference implementation.
- **T3 (2 days):** k8s-exec route + the remaining step types.
- **T4 (1 day):** hermes terminal-backend `twill`.
- **T5 (deferred):** Card/skuld (holding note); MCPServer/Skill/AgentProfile
  kinds via their own specs; `status:` controller; Authelia OIDC.

## Appendix A. v2 sketch — the `agent` route type

(Reserved design space, not v1alpha1: a route `type: agent` realizing
AWCP-style workspace *delegation*, lease-bounded, carrying an executor
selector. References §7.1 of the composite rationale. Not to be implemented
from this spec; when the v2 spec for dispatch lands this section moves there.)
