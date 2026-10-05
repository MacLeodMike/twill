# Twill — Workspace kind spec

**Status:** Revision 9 — reviewed (SHIP-WITH-NITS 2026-10-05)
**Date:** 2026-10-04
**Inherits:** `2026-10-04-twill-fabric-core.md` (revision 10, authoritative).
This document instantiates; it does not restate or redefine core.
**Scope:** the `Workspace` kind — schema, lifecycle mapping, route types,
preconditions, adapters, deployment.

---

## 1. What this kind is

`Workspace` is the storage-backed kind the fabric exists to carry. In the
party model: the **registry** is the workspace registry service; the
**provider** is whatever owns the physical place a workspace lives
(workstation daemon, cluster controller, CI image); the **consumer** is the
agent adapter.

## 2. Workspace schema

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: workstation-repos, labels: { twill/workspace-class: git } }
spec:
  owner: user:example
  routes: []
  workspace:
    storageBacked: true                   # core §4.3
    accessMode: RWO                       # RWO | RWX — §3
    storage:
      id: ws_01J8Z4-workstation-repos
      fingerprint: vol-2c4f1a             # REQUIRED — kind-owned value vocab, §2.1
    hostname: workstation
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full | readonly | none
status: {}
```

### 2.1 Fingerprint value vocabulary

Core §8.3 has the load-reject rule (aliasing detection) and is not
restated here. Workspace kind picks the fingerprint *value* by route
type:

- `local`-backed: the backing volume's UUID / filesystem UUID.
- `ssh`-backed: the workstation's machine-id (content-stable across
  reinstalls of the same host).
- `k8s-exec`-backed: the PVC UID.

### 2.2 Git worktrees: first-class children

Kind-crossing rule: a Workspace's `spec.parent` must be a Workspace
(parent pools or repo workspaces). Claims parent Workspaces; Workspaces
never parent Cards or vice versa.

A git worktree of a repo workspace is its own Workspace document
(core §4.2, §4.3):

```yaml
kind: Workspace
metadata: { name: payments-repo-feat-x }
spec:
  owner: user:example
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos/payments-repo/wt/feat-x
  workspace:
    storageBacked: true
    accessMode: RWO
    storage:
      id:        ws_01J8Z4-payments-repo-feat-x  # <parent-storage.id>-<worktreeName>
      fingerprint: vol-2c4f1a                  # matches parent (same volume)
  parent: { kind: Workspace, name: payments-repo }
```

Siblings are the common case (many branches = many children at depth 1);
all siblings share one root's `storage.id` prefix *and* one fingerprint
value; the §8.3 sibling exemption handles them.

## 3. accessMode

`RWO` (default) | `RWX`. Informational in v1alpha1. **v1alpha1 advisory
rule**: adapters SHOULD warn when opening an RWO workspace whose
`claimedBy` (from its `claimedOn` fingerprint) is non-empty, and proceed
only deliberately; RWX offers no such warning lane. Lease mechanics
(v2) are where `ready`-flips-on-first-claim lands.

## 4. Route types

Kind-owned enum (core §6.2):

| `type` | Mechanism | Required kind fields | Optional kind fields |
|---|---|---|---|
| `local` | fs+shell on the provider's host | `path` | — |
| `ssh` | SSH exec + SFTP | `address`, `path` | `user`, `port` |
| `k8s-exec` | `kubectl exec` + PVC | `pvc`, `path` | `namespace`, `context` |

### 4.1 k8s-exec targets a PVC, not a pod

Address stability. Pod references are a provider/adapter-side convention
(`twill-ws-<k8sName(storage.id)>` — RFC 1123-sanitized: lowercase,
dashes, no underscores; the pod's lifecycle belongs to the provider that
materialized the workspace; consumers never name pods directly).

## 5. Workspace lifecycle → status surface mapping

The Workspace spec owns the kind-lifecycle-*to-protocol* mapping;

| Workspace lifecycle state | `ready` | `provisionable` | `progress` |
|---|---|---|---|
| `cold` | `false` | `true` | e.g. `"workspace registered, no volume yet"` |
| `provisioning` | `false` | `true` (usually) | e.g. `"cloning repo ..."`; provider may mark non-wakeable states `provisionable: false` |
| `ready` | `true` | `false` | anything (advisory) |
| `degraded` | `false` (see below) | `false` (usually) | recommended: provider's reason |
| `down` | `false` | `false` | anything |
| unknown | `false` | `false` | spec violation |

`degraded` is not-selecting: treat as not-ready for new consumers. (The
provider's reason goes in `progress`.)

Namespaced extensions allowed (`k8s:fenced`, `pvc:restoring`); they
degrade to the nearest concrete state above.

## 6. Cold-workspace wake contract (v1alpha1)

The enterprise case: 1000 registered workspaces, most not materialized.

E2E loop a consumer's adapter runs (and every implementer must produce):

1. `resolve(Workspace, name, consumer)` → `Attached` descriptor with
   `ready: false, provisionable: true` (selection is cheap and
   non-blocking; resolve never blocks on provisioning).
2. The adapter GETs the workspace document (`GET /twill/v1alpha1/
   Workspace/<name>`) to obtain `spec.workspace.storage.fingerprint`
   (the resolve descriptor does not carry it), then POSTs a `Claim`
   document against the workspace: `parent` = the resolved workspace
   (which must exist — claims never name unmaterialized children);
   `spec.claim.principal` = the consumer's identity string;
   `claimedOn` = `{fingerprint, durable_id}`; `spec.claim.route` = the
   resolved route verbatim (which binds the claim to one provider);
   `spec.claim.parameters` = whatever the provider needs to materialize
   (`branch`, `worktreeName`, ...).
3. The registry indexes the claim. The workspace's status surface now
   includes the new claim in its `claimedBy` (derived; core §9).
4. **The provider polls `GET /twill/v1alpha1/claims?parent=Workspace/<name>`**
   (kind-qualified parent reference; the provider-claim-read-path)
   filtered by its own bound routes (exact route-object match on
   `spec.claim.route`), skipping claims with `spec.claim.released: true`,
   and begins provisioning. While provisioning it
   pushes `statusReport` against the **parent** (`provisioning`); on
   success the provider PATCHes the **new child Workspace document** into
   the registry (upsert; the overlay) with:
   - `metadata.name` = `<parent-name>-<worktreeName>` (deterministic;
     the consumer can compute it from its own claim parameters)
   - `spec.workspace.storage.id` = a pure function of the parent's
     `storage.id` and `worktreeName` (`<parent-storage.id>-<worktreeName>`)
     — deterministic, so a duplicate claim for the same worktree re-yields
     the same child id rather than minting a divergent one
   - `spec.parent` = the parent workspace
   - `fingerprint` = the parent's
   - `routes` = the claim's `spec.claim.route` copied with **two
     changes**: `path` is replaced by the materialized child path, and
     `precondition` is dropped (the child is already materialized).
     `match` and `type` are preserved exactly — the child stays scoped
     to the claiming consumer's agentLocation
   and then pushes `statusReport` against the **child** (`ready`), and a
   final parent `statusReport` restoring the parent's own state.
5. The adapter computes the expected child name from its own claim
   parameters (`<parent-name>-<worktreeName>`) and polls
   `resolve(Workspace, <child-name>, consumer)` at adapter-chosen
   interval (suggested 5–10s). Before the child exists the poll returns
   `NoMatch`; once the child document appears it returns the child's
   descriptor; when `ready: true` arrives, the adapter mints and uses
   the capability against the child's route. (For claims with no
   worktree parameters — claiming a cold *root* itself — there is no
   child: the provider materializes the parent, reports `ready` on the
   parent, and the adapter keeps polling the parent's name.)
6. On timeout the adapter gives up; the claim stays (visibility for
   operators) until the consumer explicitly releases it
   (`PATCH /twill/v1alpha1/Claim/<name>` with `spec.claim.released:
   true`).

No special-case: cold workspaces are just "not ready yet, claim them,
wait for provisioning to report `ready: true`," and the poll loop is
the only thing that waits.

Providers that cannot lazy-materialize should return `provisionable:
false` and not accept claims; claims against such workspaces are invalid
for lazy materialization purposes (the provider rejects them at
materialization time).

## 7. Preconditions (provider-side)

`precondition.steps[]` per route (core §6.3). Kind vocabulary:

| Step `type` | Fields | Semantics |
|---|---|---|
| `gitClone` | `{url, ref, credentials?}` | No-op on match; ff if ancestor+ref-clean; FAIL on dirty/diverged. |
| `worktree` | `{repo, branch, base?}` | Idempotent add; FAIL on branch-checked-out-elsewhere. |
| `pvcBind` | `{name, namespace, timeout?}` | Bind + wait; default timeout 120s. |
| `remoteMkdir` | `{}` | Ensure path. |
| `mountCheck` | `{device \| fstype}` | Verify fs backing. |

Parameters sent with a Claim (workspace-level: `branch`, `worktreeName`)
are available to `worktree` steps by reference (`{{claim.parameters.branch}}`
style, concrete substitution syntax is registry-implementation-owned).

## 8. The registry service (concrete surface)

- Process: one, YAML-watched, single replica.
- HTTP surface:
  - `GET  /twill/v1alpha1` (discovery; core §10.3 shape)
  - `GET  /twill/v1alpha1/<kind>/<name>`
  - `POST /twill/v1alpha1/resolve`
  - `POST /twill/v1alpha1/Claim/<name>` (consumer: create a claim)
  - `PATCH /twill/v1alpha1/Claim/<name>` (consumer: release)
  - `GET  /twill/v1alpha1/claims?parent=<kind>/<name>` (provider: read
    claims against a parent; parent is kind-qualified since names are
    per-kind)
  - `POST /twill/v1alpha1/<kind>/<name>/statusReport` (provider push)
  - `GET  /twill/v1alpha1/health` (`{"documentSet": current|stale, ...}`)
  - `PATCH /twill/v1alpha1/<kind>/<name>` (v1-alpha)
- Auth: deployment-side in v1alpha1 (tailnet LB only, or a token header);
  `principal` self-declared.
- Load-reject / reload: core §8.3's rule — fingerprint-sibling pairs
  un-rejected; aliasing pairs without lineage rejected; serve-last-good;
  `/health` reports current/stale.
- Sources and the writable overlay: the **watched source** (ConfigMap or
  bind-mount) is read-only to the registry — Flux or the operator owns it,
  and the registry never writes it. API-written documents (consumer
  `POST`/`PATCH` of Claims, provider `PATCH` of materialized child
  Workspaces) live in a **writable overlay**: a JSONL file on the
  registry's PVC, merged over the watched source at read time. Union
  semantics: the document set is `watched ∪ overlay`; on name collision
  the overlay wins (and the shadowing is reported in `/health`'s
  `warnings`); the overlay survives restarts (claims and materialized
  children are durable, not cache). `PATCH` is upsert on the document
  surface (a `PATCH` against a not-yet-existing name creates the
  document). **Writes are validated before append**: a write whose
  merged result would violate §8.3 (fingerprint collision without
  lineage, duplicate durable id, parent cycle) is rejected with an error
  to the writer, never persisted — one bad PATCH cannot poison every
  subsequent reload. The §8.3 document set means the union.
  **Claim collision rule**: `POST` against an existing Claim name is
  rejected; `PATCH` on a Claim is restricted to setting
  `spec.claim.released` — a live claim cannot be silently overwritten
  by another consumer.
- Provider↔document binding is deployment-configured in v1alpha1: the
  registry's own config states which provider handles which workspaces
  (a label convention, e.g. `twill/provider: <name>`, is the natural
  encoding); provider discovery is v2.

## 9. Deployment

- In-cluster: Deployment + PVC (`itty-nfs-flashy`, 4Gi); ClusterIP for
  in-cluster; Tailscale LB for workstation consumers; documents from a
  ConfigMap; chart lives in the helm-charts repo.
- Not-in-cluster: docker-compose with a bind-mount.
- No operator in v1alpha1; `status:` stays empty.

## 10. Milestones

- **T1:** registry process + document watch + `resolve` + discovery + claims
  create/read + statusReport push/pull + fingerprint reject + Workspace
  kind only. First consumer: `twill` CLI.
- **T2:** pi adapter (`twill-pi`) — local + ssh routes, provider-driven
  preconditions, claim-and-poll loop.
- **T3:** k8s-exec route + remaining step types.
- **T4:** hermes terminal-backend `twill`.
- **T5 (deferred):** Card/skuld (holding note); other kinds;
  `status:` controller; Authelia OIDC; provider discovery; Claim GC;
  RWO lease mechanics (exclusive-ready semantics).

## 11. v2 sketch

- Provider wake endpoint (provider-direct materialize-now call).
- RWO lease mechanics: first claim flips `ready: false` on an
  already-claimed workspace for new consumers; leases have TTL + renew +
  forced-release.
- AgentProfile dispatch that uses claims as its lifecycle handle.
- AWCP-informed `agent` route (composite rationale §7.1).
