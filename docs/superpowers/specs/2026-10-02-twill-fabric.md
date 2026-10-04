# Twill: an agent-agnostic work fabric

**Status:** Draft, pre-implementation
**Date:** 2026-10-02
**Scope:** twill registry + resolve/route protocol + adapters. **Not** a personal
assistant (that's `sigrun`, see its spec).
**Repo:** `twill` (currently `~/repos/pi-assistant`, to be renamed)

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

### 1.1 What twill is not

- Not an agent runtime. pi, hermes, opencode, claude-code, cursor keep running
  their own loops.
- Not a workflow engine. v1 claims and state transitions are manual.
- Not pi-specific. First adapter is pi (because `ExecutionEnv` is the cleanest
  contract in the ecosystem), but every schema decision is made against a
  six-runtime survey (§6) with runtime-neutral protocol on the wire.

---

## 2. Objects in the registry

Five object kinds. Two are v1; three are **schema-reserved** (the fields exist,
no behavior yet, land when their extension does).

| Kind | v1? | What it resolves to | Notes |
|---|---|---|---|
| `Workspace` | **Yes** | An `ExecutionEnv`-shaped capability for the requesting agent's location | The core object. §3. |
| `Card` (skuld) | **Yes** | A work item with repo_refs, workspace_ref, spec, claim state | The cross-agent kanban. §4. |
| `MCPServer` | reserved | Endpoint + credential profile per agent location | "my searxng" everywhere, no per-agent config drift |
| `Skill` | reserved | Versioned instruction bundles, registry-served | alternative to "superpowers belongs to pi, LCM to hermes" |
| `AgentProfile` | reserved | Runtime + model + host + workspace for subagent dispatch | the remote-implementer thing in §7 |

Reserving the schema now means: adapters written in v1 won't need breaking
changes when skuld/mcp/skill/dispatch land — these become "list a new kind"
features, not protocol revolutions.

### 2.1 Common shape

All five kinds follow one form (CRD-forward):

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace | Card | MCPServer | Skill | AgentProfile
metadata:
  name: <string>
  labels: {<class keys>}
spec:
  storage: { id, fingerprint }      # durable identity (workspaces/cards)
  owner: <subject>                  # day-one ACL, not boolean
  routes: []                        # ordered preferred routes per consumer selector
  profile: { toolHints, shellPolicy, ... }
status: {}                          # controller-owned in v2, absent in v1
```

The `owner` field is not optional even in v1. It costs a string and saves a
migration when multi-user lands (Authelia as IdP).

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
  storage:
    id: ws_01J8Z4-workstation-repos   # durable; env-id serialization keys on this
    fingerprint: ""                   # v2: volume UUID / machine-id, controller-verified
  owner: user:example
  routes:                             # ORDERED; first matching + reachable wins
    - match: {agentLocation: workstation}
      type: local
      path: /home/example/repos
    - match: {agentLocation: cluster}
      type: ssh
      address: workstation.tailnet.example.test
      path: /home/example/repos
    - match: {}
      type: agent                     # dial-out brokered route (v2)
      agentRef: workstation-main
  profile:
    hostname: workstation
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full                 # full | readonly | none
status: {}
```

### 3.2 Route types (v1 mechanism + reserved)

| `type` | Mechanism | v1? |
|---|---|---|
| `local` | Direct filesystem + shell | **yes** |
| `ssh` | SSH `exec` + SFTP for file ops | **yes** |
| `k8s-exec` | `kubectl exec` + PVC | **yes** |
| `agent` | Dial-out ws-agent (brokered, handles NAT/sleep) | reserved for v2 |

`agent` is reserved so a workspace-agent registration doesn't need a schema
bump. Unimplemented in v1.

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
  address: pod/twill-ws-ws_01J8Z4
  path: /workspace
  precondition: { type: gitClone, url: forgejo/.../repo.git, ref: main }
- match: {agentLocation: workstation}
  type: local
  path: ~/repos/repo/card/tw_123
  precondition: { type: worktree, repo: ~/repos/repo, branch: tw_123 }
```

Precondition types: `gitClone`, `worktree`, `pvcBind`, `remoteMkdir`, `mountCheck`.
Idempotent. Run once per claiming connection, or per lease (v2). This makes the
"spin up a container, clone the repo, start the agent" workplace problem an
**ordered list instead of a shell script**, which is the actual scaling win.

### 3.4 The one correctness invariant

pi-durable serializes `edit`/`write` by **env `id` + path**. Any two
`ExecutionEnv`s resolving to the same physical storage MUST mint envs with the
same `storage.id`. Renaming a workspace does NOT change `storage.id`. This is
the single load-bearing rule of workspace routing; adapters for runtimes
without this concept (hermes, opencode) mint their ids from `spec.storage.id`
so cross-runtime serialization still works when two runtimes share one backing
volume.

### 3.5 Resolution algorithm

```
resolve(workspaceName, consumer) -> Result<AttachedWorkspace>:
  ws     <- registry.get(Workspace, workspaceName)
  routes <- ws.spec.routes.filter(r -> matches(r.match, consumer))
  for r in routes:
    if not reachable(r): continue
    run r.precondition?            # idempotent
    env <- adapter.attach(r)       # ExecutionEnv-shaped capability
    if env.storage.id != ws.spec.storage.id: env.storage.id = ws.spec.storage.id
    return env
  return Unreachable(routes)
```

`consumer` = `{ agentLocation, agentKind, principal }` —
`agentLocation` is a self-declared string (`workstation`, `cluster`,
`laptop-lan`); `agentKind` is runtime info (`pi/0.99.1`, `hermes/0.21.1`);
`principal` is the authenticated subject (v2 auth).

Resolution is deliberate per-consumer: the same workspace name can yield a
local FS env for pi on the workstation and an SSH env for the twill-harness
in-cluster, transparently to both.

---

## 4. `Card` — skuld, the cross-agent kanban

Forgejo issues are per-repo. Homelab/enterprise work routinely spans ≥2 repos
(app repo + flux repo; N services). Card gives cross-repo execution a home.

### 4.1 Schema (v1 fields only; same CRD wrapper shape)

```yaml
spec:
  title: "Add disk-temperature alerting for TrueNAS"
  body: <markdown>
  state: idea | specced | ready | claimed | executing | review | done | blocked
  workspace_ref: workstation-repos    # optional workspaces get card claims
  spec_ref: forgejo/example/homelab-specs/...#L1
  repo_refs: [forgejo/example/truenas-alerts, forgejo/example/flux-cluster]
  owner: user:example
  claimed_by: ""                      # session/run id
  claim_token: ""                     # random, matched on update (weak unique-claimer)
  parent_card: ""                     # breakdowns (deploy X -> child cards per repo)
  labels: [observability, truenas]
```

### 4.2 API (tiny REST, SQLite-backed)

- `POST /cards` `GET /cards` `GET /cards/:id` `PATCH /cards/:id`
- `POST /cards/:id/claim` → 200 with `claim_token`; transitions `ready→claimed`
- `POST /cards/:id/release` → `claimed→ready`

### 4.3 State machine (v1, deliberately dumb)

`idea → specced → ready → claimed → executing → review → done | blocked`

`claimed` and `executing` are separate: claiming is the atomic reservation,
executing means the claimer's agent process is actually running. Lets the UI
distinguish "taken but not yet started" — the away-from-desk "did it pick it up?"
question.

No automatic transitions in v1. Agents (pi) and humans move cards; the service
validates transitions only. Workflow automation (auto-claim on conditions,
SLAs) is the thing to add when the manual loop demonstrably hurts.

### 4.4 Cards as dispatch handles (forward pointer)

When §7's AgentProfile dispatch arrives, a `claimed` Card with an AgentProfile
workspace + an approved runner model is the thing that spawns remote agents.
Cards are thus the *v1-visible* part of the subagent-dispatch design: get them
right, dispatch later is low-diff.

---

## 5. The registry service (v1)

- **Shape:** one process, config-file-backed (YAML list of CRD-shaped documents,
  watched), SQLite index for queries. In-cluster Deployment + PVC, single replica.
- **Exposes:** `GET/PATCH /twill/v1alpha1/<kind>/<name>`, `POST resolve` (§3.5,
  because resolution involves per-consumer route evaluation that shouldn't be
  re-implemented in every adapter).
- **Auth:** v1 none (private, Authelia-fronted or tailnet-only + token header).
  Schema carries principal from day one.
- **Sources (v1, both static):** bundled YAML config from a ConfigMap; in-cluster
  operator watch is v2.
- **Discovery:** `GET /twill/v1alpha1` lists object kinds (so adapters can
  discover what the fabric knows).

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

## 8. Deployment (v1)

- In-cluster: single Deployment + PVC (`itty-nfs-flashy`, 4Gi), ClusterIP svc,
  Tailscale LB svc (`twill.tailnet.example.test`), ConfigMap for the YAML
  documents. Same helm-charts repo as other example charts.
- Not-in-cluster: docker-compose with a bind-mount for the YAML; identical
  registry behavior.
- No operator in v1; `status:` stays empty.

## 9. Milestones

- **T1 (1–2 days):** registry process + resolve endpoint + YAML watch +
  Workspace kind only. First consumer: a small `twill` CLI that prints
  `resolve workstation-repos` for both `agentLocation: workstation` and
  `agentLocation: cluster`.
- **T2 (2–3 days):** pi adapter (`twill-pi` extension) — `ExecutionEnv`
  from resolved route, with precondition support. Reference implementation,
  drives any API mistakes to the surface. Local + ssh routes.
- **T3 (1–2 days):** Card/skuld service, per §4.
- **T4 (2 days):** k8s-exec route + precondition engine (`gitClone`,
  `worktree`, `remoteMkdir`).
- **T5 (1 day):** hermes terminal-backend module `twill`, minimal — enough for
  sigrun (it's a consumer too, through twill-ext-kanban).
- **T6 (deferred):** MCP server, Skill, AgentProfile schemas (fields reserved);
  `status:` writer; Authelia OIDC.

Total v1: ~1 week of focused work. T5 can be skipped if hermes isn't a target
by then; the survey (§6) means it costs almost nothing when needed.

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
