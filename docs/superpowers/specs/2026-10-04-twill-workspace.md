# Twill — Workspace kind spec

**Status:** Draft (revision 3 — parties + lifecycle + storage surface)
**Date:** 2026-10-04
**Inherits:** `2026-10-04-twill-fabric-core.md` (revision 4, authoritative).
This document instantiates that protocol; it does not restate or redefine
it. Disagreements resolve in core's favor.
**Scope:** the `Workspace` kind — schema, lifecycle mapping, route types,
preconditions, adapters, deployment.

---

## 1. What this kind instantiates

`Workspace` is the storage-backed kind the fabric exists to carry: a named
execution/storage context (a directory tree, an SSH host, a k8s pod/PVC)
that consumers resolve into fs+shell capabilities for their own location.
The three parties (core §2) land here as: the **registry** the workspace
registry service (one per deployment); the **provider** the workstation
daemon, the cluster controller, the CI image — whatever owns the physical
place a workspace lives; the **consumer** the pi adapter, hermes adapter,
etc.

Users reach Workspaces by `resolve(Workspace, name, consumer)` → route
descriptor (core §7.2) → adapter mints and attaches `WorkspaceEnv`.

## 2. Workspace schema (v1alpha1)

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: workstation-repos, labels: { twill/workspace-class: git } }
spec:
  owner: user:example
  routes: []                              # §4
  workspace:
    storageBacked: true                   # core §4.3 — Workspace IS storage-backed
    accessMode: RWO                       # RWO | RWX — §3
    storage:
      id: ws_01J8Z4-workstation-repos     # derived from nothing; this is a root
      fingerprint: vol-2c4f1a             # REQUIRED; kind-picked value — §2.1
    hostname: workstation
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full | readonly | none
  parent: null                            # or { kind: Workspace, name: <parent> } — §2.2
status: {}
```

### 2.1 Fingerprint value vocabulary (the kind-owned choice)

`storage.fingerprint` is kind-owned for WHAT value to populate (core §8.3's
load-reject rule, which lives in core and is not restated here). Workspace
kind picks: a volume UUID or filesystem UUID for `local`-backed workspaces,
a PVC UID for `k8s-exec`-backed workspaces, the workstation's machine-id
for `ssh`-backed workstations (content-stable across OS reinstalls of the
same host, which is the case where you want to catch the change).

Registries apply the load-reject at (re)load; what they do on violation is
core §8.3's consolidated rule, not business of this spec.

### 2.2 Git worktrees: first-class children (parent/child example)

The canonical child example: a git worktree of a repo workspace. The child
is its own Workspace document:

```yaml
kind: Workspace
metadata: { name: payments-repo-feat-x }
spec:
  owner: user:example
  routes:
    - match: {agentLocation: cluster}
      type: local
      path: ~/repos/payments-repo/wt/feat-x
  workspace:
    storageBacked: true
    accessMode: RWO
    storage:
      id:        ws_01J8Z4-feat-x            # derived from parent's ws_01J8Z4 — core §4.3
      fingerprint: vol-2c4f1a                 # matches parent's fingerprint (same volume)
  parent: { kind: Workspace, name: payments-repo }
status: {}
```

Children-to-children are legal (deeper nested worktrees; no practical
cap). Cycle detection is loader-side (core §4.2).

Wrong-aliasing example to avoid: the child's `storage.id` MUST differ from
the parent's (it's a different capability view), but its `fingerprint`
MUST match (same physical volume), so a mismatched pairing gets caught by
the load-reject rule rather than silently accepted.

## 3. accessMode: RWO vs RWX

`accessMode: RWO | RWX` declares the storage's concurrency story
(informational in v1alpha1; leases formalize later):

- `RWO` — single concurrent claimer (iSCSI-shaped). The Workspace
  lifecycle maps an attached `claimedBy` (non-empty) onto `ready: false`
  for new consumers. (The user-framing example: an RWO workspace that is
  attached is `claimed: true, ready: false` for everyone but the holder.)
- `RWX` — many concurrent claimers (NFS-shaped). A claim does not turn
  readiness off: attached + ready is valid for new claimers.

Default is `RWO`. Kind-owned; Card has no analogue because Card is not
storage-backed.

## 4. Route types (the Workspace enum)

| `type` | Mechanism | Kind-required fields | v1alpha1? |
|---|---|---|---|
| `local` | Direct filesystem + shell | `path` | yes |
| `ssh` | SSH exec + SFTP | `address`, `path` | yes |
| `k8s-exec` | `kubectl exec` + PVC | `pvc`, `path` — NOT a pod name | yes |

Route types are kind-owned (core §6.2). `local`/`ssh`/`k8s-exec` are this
kind's names. `agent` is not a v1alpha1 route type (composite rationale
§7.1 is the delegation design sketch).

### 4.1 Why `k8s-exec` targets a PVC, not a pod

Pod names are ephemeral. The route names the PVC; the *mechanism* of
reaching the bytes (which pod mounts them) is convention-driven: the
adapter-side convention is `twill-ws-<k8sName(storage.id)>` (RFC1123-
sanitized, lowercase-with-dashes normalized), realized by whatever spin-up
machinery the provider runs. Pod lifecycle is provider/extension business
(§6); the PVC is what the route points at.

## 5. Workspace lifecycle, mapped to the protocol status surface

The kind-owned lifecycle and the `ready`-mapping into the protocol surface
(core §8):

| Workspace-kind lifecycle state | Maps to `ready` | Notes |
|---|---|---|
| `cold` | `false` | Registered, not yet materialized; the 1000-services scenario |
| `provisioning` | `false` | The clone/restore/spin-up is in flight |
| `ready` | `true` | Materialized and no blocker to claim |
| `degraded` | `true` + progress carries "degraded" | Attachable but provider wants you to know |
| `down` | `false` | Provider reachable but reports the workspace down; provider dead = `down` by TTL expiry |
| unknown values | `false` | Spec violation, treated as `down` |

Extensions MAY be namespaced (`k8s:fenced`, `pvc:restoring`); they map
onto `ready:false` for consumers, and appear in `progress`.

**Cold workspace handling** (the enterprise case): a `cold` workspace is
not rot; it is the cheap version of the workspace (no hot volume). The
**adapter** is the party that deals with waking: when an adapter sees
`ready:false` + a `progress` text carrying "cold" (or a namespaced state
like `k8s:restoring` implying recoverable), it MAY wake the provider
directly (kind-owned wake endpoint; protocol does not standardize it)
and wait, subject to its own timeouts. This keeps resolve non-blocking:
a cold workspace resolves fast with `ready:false` + `cold` progress, and
the *wait* is owned by whoever can afford to wait — the consumer.

Removed in rev 3: the earlier veto on `Attached` when `state != ready`
is replaced by the surface contract above. Resolve is cheap;
wake-and-wait is where the time goes, and it's the consumer's place
to decide what to do.

## 6. Preconditions (provider-side)

Preconditions are the provider's materialization mechanism:
`precondition: { steps: [...] }` at the route envelope (core §6.3).
Execution context: the provider's environment against the route target;
credentials ambient to the provider. Consumers are forbidden from
executing them (core §6.3).

The Workspace kind's step vocabulary:

| Step `type` | Fields | Semantics |
|---|---|---|
| `gitClone` | `{url, ref, credentials?}` | Ensure `path` is a clone of `url` at `ref`. No-op on match; fast-forward if `HEAD` is ancestor-of-`ref` + clean tree; **FAIL** on dirty/diverged. |
| `worktree` | `{repo, branch, base?}` | Ensure a worktree of `repo` at `path` on `branch`. Create branch+worktree if absent; no-op on same branch/commit; **FAIL** if branch checked out in a different worktree. |
| `pvcBind` | `{name, namespace, timeout?}` | Ensure PVC is Bound; default `timeout` 120s. |
| `remoteMkdir` | `{}` | Ensure `path` exists (provider-side shell). |
| `mountCheck` | `{device \| fstype}` | Verify `path` is on the expected device/fstype. |

Multi-step sequences carry their natural order: `[gitClone, worktree]`
for branch work; `[pvcBind, gitClone, mountCheck]` for cold cluster
workspaces.

## 7. Consumers and WorkspaceEnv

A successful resolve→adapter flow gives the consumer a WorkspaceEnv:

```
WorkspaceEnv :: {
  FileSystem    # read/write/list, adapter-mapped per runtime
  Shell         # command execution in the workspace cwd context
  id            # = spec.workspace.storage.id (adapter-forced)
  cwd           # the workspace's root for this capability (= route.path
                # once preconditions have been satisfied per status)
}
```

The **adapter** is the actor that forces `id` (core §4.3 / §7.2). Pi's
`ExecutionEnv` is the natural first target because its contract is
already this shape; hermes gets a `twill` terminal-backend module;
opencode gets a config generator; cursor maps `precondition` onto
`.cursor/worktrees.json`. (Composite rationale §6 has the full table.)

Adapters treat the status's `ready` as advisory: they may attach eagerly
and fail their own way, or wait/poll. The protocol does not standardize
adapter wake semantics beyond §5's cold note.

## 8. The registry service (concrete surface)

The concrete registry shape (abstract in core §10.3):

- **One process**, YAML-watched documents, single replica.
- **HTTP surface** (URLs owned by this spec):
  - `GET  /twill/v1alpha1` → discovery list (core §10.3 shape)
  - `GET  /twill/v1alpha1/<kind>/<name>` → the document
  - `POST /twill/v1alpha1/resolve` → Attached/NoMatch/Unreachable (core §7)
  - `POST /twill/v1alpha1/<kind>/<name>/statusReport` → provider push
  - `GET  /twill/v1alpha1/health` → `{"documentSet": "current|stale",
    "rejectedAt"?: ..., "reason"?: ...}` (core §8.3)
  - `PATCH /twill/v1alpha1/<kind>/<name>` — v1-alpha; deployment-side auth.
- **Documents:** ConfigMap or bind-mount, watched.
- **Auth:** v1 deployment-shaped (tailnet-only service, or token header);
  `principal` self-declared.
- **Apply:** the load-reject rule + serve-last-good behavior on violation
  (core §8.3) — the registry keeps serving the previous valid set and
  reports `documentSet: stale` on `/health`.

## 9. Deployment

- **In-cluster (primary):** Deployment + PVC (`itty-nfs-flashy`, 4Gi);
  ClusterIP for in-cluster; Tailscale LB Service for workstation
  consumers; documents from a ConfigMap; chart lives in the helm-charts
  repo; single replica.
- **Not-in-cluster:** docker-compose with a bind-mount for the YAML.
- **No operator in v1alpha1;** `status:` stays empty.

## 10. Milestones

- **T1 (1–2 days):** registry process + `POST /resolve` + document watch
  + discovery + provider-push `statusReport` surface + fingerprint
  load-reject + Workspace kind only. First consumer: `twill` CLI making
  HTTP calls (prints the route descriptor; not a second resolver).
- **T2 (2–3 days):** pi adapter (`twill-pi` extension) — local + ssh
  routes, provider-driven preconditions.
- **T3 (2 days):** k8s-exec route + remaining step types.
- **T4 (1 day):** hermes terminal-backend `twill`.
- **T5 (deferred):** Card/skuld per holding note; other kinds;
  `status:` controller; provider discovery.

## 11. v2 sketch (not to implement from)

- **Wake endpoint (provider-side)**: standardize one URL+contract for
  "wake this workspace" so adapters don't each reinvent it.
- **Lease lifecycle** on claims: TTL + renew + release, closing the RWO
  second-consumer story.
- **`agent` route type**: AWCP delegation (composite rationale §7.1).
- **GC of ephemeral dependents** when parent is deleted; today deletion
  is manual per core §4.2.
