# Twill: an agent-agnostic work fabric

**Status:** Draft, pre-implementation (structured as rationale + roadmap —
the implementation specs that supersede parts of this composite are listed in
§0.0)
**Date:** 2026-10-02 (updated 2026-10-04: Card moved to holding note; AWCP added)
**Scope:** twill registry + resolve/route protocol + adapters. **Not** a personal
assistant (that's `sigrun`, see its spec).
**Repo:** `twill` (currently `~/repos/pi-assistant`, to be renamed)

### 0.0 Spec structure (post-2026-10-04)

During review, this composite was recognized as the wrong unit for
implementation planning (it bundles one thin protocol, one buildable kind,
and three reserved kinds). The fabric is now structured as **one protocol
spec plus one spec per built kind**, with Card and the other reserved kinds
parked:

| Doc | Role | Status |
|---|---|---|
| `2026-10-04-twill-fabric-core.md` | The protocol: CRD wrapper, `storage.id` invariant, routes, resolve algorithm, version policy. **Nothing runnable.** Injects no kind-specific behavior. | drafted 2026-10-04, in review |
| `2026-10-04-twill-workspace.md` | The Workspace kind: schemas, route types, `precondition`, adapters, deployment. Implementation target. | draft revision 3, in dual review |
| `../research/2026-10-04-twill-card-holding-note.md` | Card / skuld schema pins + deferred-design notes. **Not a spec.** | done |
| `2026-10-04-twill-workspace.md` | The Workspace kind: schemas, route types, preconditions, adapters, deployment. Implementation target. | draft revision 2, in dual review |
| agent / mcp / skill kinds (§2, §7 here) | reserved only | unchanged |

**Inheritance rule:** kind specs inherit the core protocol spec; they may not
restate or redefine it. Any disagreement is resolved in favor of core. The
remaining sections of this document are the *rationale* (§1–2, §6) and the
*roadmap* (§8–10) the specs derive from; where this composite and a child
spec disagree, the child spec wins for its kind.

---

## 1. What this is

Twill is a **typed directory of fabric objects with a resolve/route protocol**,
designed so heterogeneous agent runtimes can share workspaces, work items, MCP
server bindings, skills, and subagent dispatch targets — without any runtime
needing to know how the others work.

The core thesis:

> What agent runtimes already do (ssh terminal backends, worktrees, project
> workspaces) is the answer to "how do I connect to a workspace?" What nothing
> does is: "given a **name**, where is the workspace **for me**, how did it come
> to exist, and who else is using it?" Twill is that layer.

Today every agent solves this per-runtime: hermes has terminal backends, pi has
`ExecutionEnv`, opencode has static project configs, cursor has a
provisioning-hook JSON. Twill raises the common structure into a registry.
Adding a new workspace (or changing where one lives) becomes a registry edit,
not a config in every agent.

Within today's agent protocol landscape — MCP (agent ↔ tool), A2A/ANP
(agent ↔ agent) — twill occupies the missing **agent ↔ workspace** layer: the
registry that decides *which* remote mechanism, per object, per consumer. It
complements rather than competes with transport-level protocols such as AWCP
(arXiv 2602.20493), which the reserved `agent` route type references (§7.1).

### 1.1 What twill is not

- Not an agent runtime. pi, hermes, opencode, claude-code, cursor keep running
  their own loops.
- Not a workflow engine. v1 claims and state transitions are manual.
- Not pi-specific. First adapter is pi (because `ExecutionEnv` is the cleanest
  contract in the ecosystem), but every schema decision is made against a
  six-runtime survey (§6) with runtime-neutral protocol on the wire.

---

## 2. Objects in the registry

Five object kinds. One is v1 (`Workspace`); four are **schema-reserved** (the
fields exist, no behavior yet, land when their extension does). Card's schema
is pinned (see `../research/2026-10-04-twill-card-holding-note.md`) but its
implementation is deferred — see §0.0 and §4.

| Kind | v1? | What it resolves to | Notes |
|---|---|---|---|
| `Workspace` | **Yes** | An `ExecutionEnv`-shaped capability for the requesting agent's location | The core object. §3. |
| `Card` (skuld) | schema only | A work item under `spec.card` (id, state, repo_refs, spec_ref, claim state) | Deferred; see holding note (`../research/2026-10-04-twill-card-holding-note.md`) |
| `MCPServer` | reserved | Endpoint + credential profile per agent location | "my searxng" everywhere, no per-agent config drift |
| `Skill` | reserved | Versioned instruction bundles, registry-served | alternative to "superpowers belongs to pi, LCM to hermes" |
| `AgentProfile` | reserved | Runtime + model + host + workspace for subagent dispatch | the remote-implementer thing in §7 |

Reserving the schema now means: adapters written in v1 won't need breaking
changes when skuld/mcp/skill/dispatch land — these become "list a new kind"
features, not protocol revolutions.

### 2.1 Common shape

All five kinds follow one form (CRD-forward). The concrete envelope is
owned by `2026-10-04-twill-fabric-core.md` (§2): top-level `spec.` carries
`owner`, `routes`, and `spec.<kindname>` (the kind's own data, including its
durable id); details there. The load-bearing constraints for this document:
`owner` is required from day one (a string now vs an ACL migration later);
`status` is reserved (readers must treat it as opaque; writers in v1alpha1
must leave it empty); `storage.id` is present on storage-backed kinds and
carries the write-serialization invariant (fabric-core §4.3).

---

## 3. `Workspace` — the core object

### 3.1 Schema (v1)

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata:
  name: workstation-repos
  labels:
    twill/workspace-class: git        # git | shell | media | data
spec:
  workspace:
    storageBacked: true                # declared, not inferred (fabric-core §4.3)
    accessMode: RWO                    # RWO | RWX, kind-owned (v1alpha1 default RWO)
    storage:
      id: ws_01J8Z4-workstation-repos # durable; env-id serialization keys on this
      fingerprint: vol-2c4f1a         # REQUIRED, content-stable (fabric-core §8.3)
    hostname: workstation
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full                 # full | readonly | none
  owner: user:example
  routes:                             # ORDERED; first matching + reachable wins
    - match: {agentLocation: workstation}
      type: local
      path: /home/example/repos
    - match: {agentLocation: cluster}
      type: ssh
      address: workstation.tailnet.example.test
      path: /home/example/repos
    # v2 sketch (AWCP-style delegation, see §7.1). Not a v1alpha1 route type.
    # - match: {agentLocation: anywhere}
    #   type: agent
    #   lease: { ttl: 3600, access: read-write }
status: {}
```

### 3.2 Route types (v1 mechanism + reserved)

| `type` | Mechanism | v1? |
|---|---|---|
| `local` | Direct filesystem + shell | **yes** |
| `ssh` | SSH `exec` + SFTP for file ops | **yes** |
| `k8s-exec` | `kubectl exec` + PVC | **yes** |

These three are the Workspace kind's route-type vocabulary in v1alpha1. (The
fabric core protocol fixes only the route *envelope*; each kind owns its own
`type` set — see fabric-core §6.2.) The `agent` route type from earlier
drafts is **not** a v1alpha1 route; the delegation idea it gestured at lives
on in §7.1 as a v2 design sketch informed by AWCP.

### 3.3 **Provisioning is a first-class route concern** ← key decision

Every runtime we surveyed re-implements workspace *materialization* as a side
channel: cursor does it with `worktrees.json` post-create hooks, pi-durable
does it as env-per-conversation builders, hermes does it with per-backend
container spin-up. The mechanism they're all looking for is: **ensure the
storage exists before connecting.**

So each route carries an optional `precondition`:

```yaml
- match: {agentLocation: cluster}
  type: k8s-exec
  pvc: data-ws-01J8Z4
  namespace: workspaces
  path: /workspace
  precondition:
    steps: [ { type: gitClone, url: forgejo/.../repo.git, ref: main } ]
- match: {agentLocation: workstation}
  type: local
  path: ~/repos/repo/card/tw_123
  precondition:
    steps: [ { type: worktree, repo: ~/repos/repo, branch: tw_123 } ]
```

Precondition types: `gitClone`, `worktree`, `pvcBind`, `remoteMkdir`,
`mountCheck`. Idempotent. Provider-executed. This makes the "spin up a
container, clone the repo, start the agent" workplace problem an **ordered
list instead of a shell script**, which is the actual scaling win.

### 3.4 The one correctness invariant

pi-durable serializes `edit`/`write` by **env `id` + path**. Any two
`ExecutionEnv`s resolving to the same physical storage MUST mint envs with the
same `storage.id` (`spec.workspace.storage.id`). Renaming a workspace does NOT
change `storage.id`. This is the single load-bearing rule of workspace
routing; the **adapter** is the responsible actor (fabric-core §4.3, §7) so
cross-runtime serialization still works when two runtimes share a backing
volume. The fingerprint mechanism that lets a registry *reject conflicting
aliases* at load is core §8.3.

### 3.5 Resolution and parties

The concrete resolution algorithm (`resolve(kind, name, consumer)` →
Attached/NoMatch/Unreachable against a route-descriptor shape) is owned
by fabric-core §7; the **party split** that governs it — registry selects,
provider materializes and reports state, consumer attaches — is core §2.
This composite's §3.5 in earlier drafts carried resolver-run preconditions
and resolver-invoked attach; that shape is now recognized as unimplementable
(registry can't reach consumer-local routes, can't serialize a capability),
and the party-model of core rev 4 is the replacement.

The `consumer` tuple is `{ agentLocation, agentKind, principal }`, each a
string. Match on the runtime family (`pi`, `hermes`), not a versioned
agentKind (core §7.1 guidance).

Resolution is deliberately per-consumer: the same name yields a local FS
env to pi on the workstation and an SSH env to the twill-harness in cluster.

---

## 4. `Card` — skuld, moved to a holding note

Card's rationale (cross-repo work has no per-repo home; cards as future
dispatch handles) is unchanged, but its design was judged underbaked relative
to the fabric layer during 2026-10-04 review. Card was extracted to
`../research/2026-10-04-twill-card-holding-note.md`, which preserves the
schema pins needed for fabric forward-compatibility plus the full revisit
inputs (AWCP lease model, Beads, Agent Teams). Implementation is **deferred
until after** the fabric + `twill-workspace` deployment.

Do not implement Card from this document.

---

## 5. The registry service (v1)

- **Shape:** one process, config-file-backed (YAML list of CRD-shaped documents,
  watched), SQLite index for queries. In-cluster Deployment + PVC, single replica.
- **Exposes:** `GET/PATCH /twill/v1alpha1/<kind>/<name>`, `POST resolve`
  (concrete shape of the abstract resolution in fabric-core §7, kept in the
  registry because route evaluation shouldn't be re-implemented in every
  adapter).
- **Auth:** v1 none (private, Authelia-fronted or tailnet-only + token header).
  Schema carries principal from day one.
- **Sources (v1, both static):** bundled YAML config from a ConfigMap; in-cluster
  operator watch is v2.
- **Discovery (abstract, owned by fabric-core §10.3):** a list of object
  references with `{ kind, name, durable_id, resolvable }`, including inert
  objects (`resolvable: false` when a kind has no registered kind-runner or
  routes are empty). The concrete transport (HTTP, file walk, CLI output) is
  the registry service's implementation decision in the workspace kind spec.

## 6. Runtime compatibility survey (drove §3.3 / §3.4)

The map from each runtime's workspace model to twill:

| Runtime | Native scope shape | Twill adapter |
|---|---|---|
| **pi / pi-durable** | `ExecutionEnv { FileSystem, Shell }` per conversation, `env.id` serializes writes | Reference adapter: resolve → `ExecutionEnv` directly. Fully dynamic. ~200 lines. |
| **hermes** | terminal backend modules (`local`, `docker`, `ssh`, `sshd`) | New backend module `twill` that resolves each session's workspace through the registry. Same shape as its existing backends. |
| **opencode** | static per-project config (each project = one host-side dir) | Adapter = config-template generator from the registry; opencode stays static, twill edits the file. |
| **claude code** | local FS only; "remote control" steers a local session | Attach-only route: workspace is local, remote-steering is solved by them upstream. |
| **cursor** | git worktrees, `.cursor/worktrees.json` provisioning hook | Attach-only + provisioning adapter that maps our `precondition` to their hook format. |
| **openclaw** | gateway-host workspace dir, per-channel isolation | Attach-only or generator, same as opencode. |

**Conclusion 1:** three shapes exist — *native dynamic* (pi, hermes), *static
config* (opencode, claude-code), *worktree-provisioning* (cursor) — and all
three are served by the same v1 API. Adapter ≠ shim; each is idiomatic to its
runtime. Pi's is the thinnest because `ExecutionEnv` is the cleanest contract.

**Conclusion 2:** no other runtime has pi's `env.id` write-serialization
concept. Twill keeps it (§3.4) and supplies it to adapters that don't have it
natively.

## 7. `AgentProfile` — reserved, v2+

Remote subagent dispatch (the "implementer runs on a different host,
transparent to the parent" thing) is the coolest extension and the hardest —
it needs streaming, steering, cancellation, and result contracts across
processes, none of which is trivial. Schema is reserved now so v1 adapters
don't collide with its fields later:

```yaml
kind: AgentProfile
metadata: { name: implementer }
spec:
  runtime: pi
  model: { provider: gateway, name: glm-5.3 }
  hostRef: cluster-worker-pool       # where the runtime is spawned
  workspace_ref: workstation-repos   # shared with parent; §3.4 invariant applies
  budget: { maxChildDepth: 1 }
```

Dispatch protocol is out of scope for v1.

### 7.1 The `agent` route type — delegation, not brokering

The reserved `agent` route type is **workspace delegation**: the consuming
runtime leases the workspace *to* a remote executor (e.g. a subagent on another
host sharing the parent session's workspace), which operates on the files with
its own toolchain and returns results. This supersedes the earlier "dial-out
brokered ws-agent" sketch: brokering a shell re-implements SSH badly, whereas
delegation is the pattern the literature formalizes — AWCP (arXiv 2602.20493,
*Agent Workspace Collaboration Protocol*) is the reference protocol and a
candidate implementation basis.

Design inputs taken from AWCP, applied when §7 lands:

- **Lease-bounded access.** Delegations carry a TTL and an access mode
  (read-only | read-write); the executor may *narrow* the terms (cap the TTL,
  downgrade write → read-only) instead of a bare accept/reject. This maps onto
  the claim/lease machinery Cards grow in v2.
- **Transport capability declaration.** Each delegation transport (SSHFS-style
  live mount, archive, object storage, git) declares live-sync vs snapshot; the
  declaration selects the reconciliation strategy (apply automatically / stage
  for review / discard). The `agent` route schema carries this capability bit
  when specified.
- **Dual state machines.** Delegator side owns the full lifecycle (negotiate →
  provision → execute → reconcile); executor side is deliberately minimal.
  Synchronization is via protocol messages only — no shared state store. This
  keeps twill's fabric stateless about delegation progress.

Adoption posture: twill's schema should be *compatible with* AWCP's delegation
model (their `TransportHandle` overlaps `precondition`; their lease maps onto
route terms), but the AWCP implementation is not adopted wholesale — it has no
registry, no per-consumer resolution, and no k8s/route concerns. Exact
message-level compatibility is a §7-implementation-time decision.

## 8. Deployment (v1)

- In-cluster: single Deployment + PVC (`itty-nfs-flashy`, 4Gi), ClusterIP svc,
  Tailscale LB svc (`twill.tailnet.example.test`), ConfigMap for the YAML
  documents. Same helm-charts repo as other example charts.
- Not-in-cluster: docker-compose with a bind-mount for the YAML; identical
  registry behavior.
- No operator in v1; `status:` stays empty.

## 9. Milestones

- **T1 (1–2 days):** registry process + `POST /resolve` + document watch +
  discovery + `Workspace.statusReport` + fingerprint load-reject +
  Workspace kind only. First consumer: the `twill` CLI making HTTP calls
  (prints the route descriptor; not a second resolver).
- **T2 (2–3 days):** pi adapter (`twill-pi` extension) — local + ssh routes
  + provider-driven preconditions; reference implementation.
- **T3 (2 days):** k8s-exec route + remaining step types.
- **T4 (1 day):** hermes terminal-backend module `twill` (sigrun consumer).
- **T5 (deferred):** Card/skuld per the holding note; MCP server, Skill,
  AgentProfile schemas (fields reserved); `status:` writer; Authelia OIDC.

Target: a working twill + twill-workspace deployment before Card work begins;
the survey (§6) means adapters cost almost nothing when needed.

## 10. Sibling project

`sigrun` — the pi-durable-based assistant (hermes replacement). Owns none of
this. Consumes twill as a dependency: its kanban tools call skuld, its
workspaces resolve through twill, its harness is a normal agent runtime
(`agentLocation: cluster`). See its spec in `~/repos/sigrun`.

## Appendix — ecosystem research sources

- hermes terminal backends (all four): hermes-agent.nousresearch.com/docs/user-guide/features/tools
- pi ExecutionEnv contract: pi-agent-core/dist/harness/types.d.ts (FS + Shell interfaces, ~20 methods)
- pi-durable env-per-conversation: packages/durable README, example 29-sandbox-per-conversation
- cursor worktrees + provision hooks: cursor.com/docs/configuration/worktrees
- claude-code remote control: code.claude.com/docs/en/remote-control
- opencode: opencode.ai docs (project model is client-server, static)
- openclaw: docs.openclaw.ai/concepts/architecture (gateway workspace dir)
