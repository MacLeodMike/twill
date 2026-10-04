# Context: why twill exists

> Companion to `docs/superpowers/specs/2026-10-02-twill-fabric.md` (the *what*).
> This document is the *why* — problems, scenarios, and the reasoning that
> produced the design. Written 2026-10-02 from the design session that created
> twill.

---

## 1. The problem

Every agent runtime solves "where does my work happen?" independently, and
solves it statically.

- **hermes** has terminal backends (`local`, `docker`, `ssh`, `sshd`).
- **pi** has `ExecutionEnv` and third-party route extensions (`pi-ssh-remote`,
  `pi-sbx`).
- **opencode** has per-project configs baked into a config file.
- **cursor** has git worktrees plus a `.cursor/worktrees.json` provisioning hook.
- **claude code** runs local-only, with a "remote control" feature that steers a
  local session from another device.

Each of these answers *"how do I connect to a workspace?"* — usually well. None
of them answers:

> Given a **name**, where is that workspace **for me**, how did it come to
> exist, and what else is attached to it?

The consequences show up as config drift and ceremony:

- Adding a new place to work means editing every agent's config.
- Two agents "sharing a workspace" means configuring two different transports by
  hand and hoping they point at the same bytes.
- Every task that needs a fresh environment re-implements the same scaffolding
  (spin up a container or VM, clone the repo, install, start the agent) as a
  bespoke shell script.
- Work that spans more than one repository has no home. Forgejo issues are
  per-repo; a homelab deploy touches the app repo *and* the flux repo.

Twill raises the common structure into a registry: a typed directory of fabric
objects with an ordered, per-consumer **resolve-and-route** protocol.

---

## 2. Scenarios

### 2.1 Homelab (the immediate one)

One person, a handful of machines (workstation, two TrueNAS boxes, a Talos
cluster), an existing set of agent runtimes (pi on the workstation, a pi-durable
assistant in-cluster, hermes during transition), and a GitOps repo layout where
essentially all real work is git-committed.

Today this can be hand-wired and mostly works: point hermes at its ssh terminal
backend, install `pi-ssh-remote` in pi, and both agents see the same remote
directory. That is the honest baseline — **twill is not required to share a
workspace between two agents on a homelab.**

What twill adds here:

- One place to declare a workspace instead of N agent configs.
- The same name resolving to a local path for the workstation agent and an SSH
  path for the in-cluster agent, with no config duplication.
- Cards as the cross-repo work ledger, so "deploy X" (app repo + flux repo) is
  one item instead of two issues and a note.
- A stable seam that survives agent swaps. If the assistant moves from hermes to
  the pi-durable project (it did — see `sigrun`), nothing in the fabric changes.

### 2.2 Workplace scale (the one that justifies the design)

Several hundred to 1000+ microservices, each in its own Bitbucket project/repo,
with a microservice-oriented architecture.

Orchestrating coding agents across that estate is where static, per-runtime
workspace configuration breaks down. The per-task ceremony becomes:

> spin up a container or VM → clone the relevant repo → install dependencies →
> configure the agent → run it → tear down

Doing that 1000 times does not scale — not for cost, not for configuration
surface, not for the number of places a route can be declared.

With a registry, that ceremony becomes data:

- A workspace per service, declared once.
- An agent requesting `resolve(svc-payments)` gets whichever route is correct
  for *its* location: `k8s-exec` into a pod with the repo already materialized
  (init-clone, CSI volume, or git-sync sidecar) for a cluster runner, or the
  local checkout for a workstation agent.
- Materialization is an ordered `precondition` list, not a shell script
  (§3.3 of the spec).

The sentence that made the requirement concrete: *"you could have `pi` on your
workstation launch a sub-agent that would pull in the relevant workspace
dynamically, with the git repo already present."*

### 2.3 Transparent remote subagents (the horizon)

A `pi` session running an SDD workflow calls its `implementer` subagent — except
that subagent runs on a different host, against a shared workspace, and the
parent session cannot tell the difference.

This is the most compelling extension and the hardest: transparent remote
fan-out needs streaming, steering, cancellation, and result contracts preserved
across process boundaries. Twill reserves the schema for it (`AgentProfile`) and
deliberately does not build the dispatch protocol in v1. Cards double as the
dispatch handle when it lands, which is why §4 of the spec is written with one
eye on it.

---

## 3. What else could live in the fabric

The insight that generalized the project: **workspaces, work items, MCP servers,
skills, and subagent profiles are the same shape.**

```
fabric object = spec (what it is, CRD-shaped) + routes[] (how YOU reach it)
```

| Kind | Resolves to | v1 |
|---|---|---|
| `Workspace` | an fs+shell capability for the consumer's location | yes |
| `Card` (skuld) | a work item with repo refs, spec link, claim state | yes |
| `MCPServer` | endpoint + credential profile per location | reserved |
| `Skill` | versioned instruction bundles, registry-served | reserved |
| `AgentProfile` | runtime + model + host + workspace for dispatch | reserved |

`MCPServer` in particular is the same problem as workspaces wearing a different
hat: how does *this* agent, from *this* location, reach the searxng/crawl4ai/...
service? In-cluster DNS, tailnet address, or localhost — per consumer. Exactly
the route problem.

---

## 4. Why agent-agnostic (not a pi feature)

The initial target is the pi ecosystem, because pi's `ExecutionEnv` is the
cleanest workspace contract in the field and pi-durable makes the harness side
easy to implement against. But the design is not pi-specific, for a concrete
reason:

> If you put real work into plugging `pi` into your `hermes` kanban, you have
> just made it that much harder to move to `nanobot`.

Cross-agent tools glued into one agent's extension model convert a choice into a
migration. Cross-agent tools behind a neutral registry keep the choice open. This
is why twill owns the protocol and each runtime gets a thin, idiomatic adapter —
not a shim — and why the v1 schema was validated against six runtimes (§6 of the
spec) before being frozen.

Adapter shapes differ by runtime and that is fine:

- **pi / pi-durable** — native dynamic. Resolve → `ExecutionEnv`. ~200 lines, the
  reference implementation.
- **hermes** — a terminal-backend module named `twill`, shaped like its existing
  backends.
- **opencode** — static config, so the adapter is a config generator.
- **claude code / cursor / openclaw** — attach-only (or map `precondition` onto
  their native provisioning hook for cursor).

---

## 5. Design decisions that carry weight

1. **Provisioning is a route concern, not a side channel.** Cursor's
   `worktrees.json`, pi-durable's env-per-conversation builders, and hermes's
   per-backend container spin-up are all the same missing concept: *ensure the
   storage exists, then connect*. Hence `precondition`.
2. **One invariant: the env id.** pi-durable serializes file writes by
   environment id + path. Two environments resolving to the same physical
   storage must share an id or they will corrupt each other's edits. Renaming a
   workspace must not change its `storage.id`. Everything else in the protocol
   is negotiable; this is not.
3. **Resolve and route; do not co-locate.** The fabric holds registries, not
   bytes. Compute and storage live wherever they already live.
4. **CRD-forward schemas from day one.** v1 is a YAML config file in k8s
   resource shape. v2 is an operator reading the same documents as CRDs. No
   migration, and `status:` is reserved from the start so hand-edits never fight
   a controller later.
5. **`owner` is not optional, even single-user.** A string field now versus an
   ACL migration later.
6. **Dumb state machine.** No auto-transitions, no workflow engine, no leases in
   v1. Add machinery when the manual loop demonstrably hurts.

---

## 6. Names

- **twill** — a diagonal-rib weave; workwear cloth. Strong and durable, matching
  the "work fabric" framing. Chosen after `warp`/`weft`/`loom` were ruled out:
  warp.dev is an AI terminal, and four separate projects named `weft`, three of
  them in the agent space, including a task board and a durable execution
  engine.
- **skuld** — one of the Norns; "that which shall become." Reserved for the
  card/work-item side of the fabric; the v1 implementation of `Card` ships
  under the twill API and can be rebranded without protocol change.

---

## 7. Sibling project

**`sigrun`** (`~/repos/sigrun`) — the pi-durable personal assistant that
replaces hermes. It is twill's first large consumer: kanban via skuld,
workspaces via resolution, and the harness itself is just another runtime
declaring `agentLocation: cluster`.

The two are deliberately decoupled. Twill knows nothing about assistants;
sigrun knows about twill only through a swappable wrapper. Either can ship
without the other, and the sequencing reflects that: sigrun's harness and webui
land against static workspace config, then swap to resolution when the pi
adapter exists.

---

## 8. Non-goals

- Not an agent runtime, loop, or UI.
- Not a workflow/automation engine.
- Not a better remote shell — it is the layer that decides *which* remote
  mechanism, per object, per consumer.
- Not a secret manager. Credentials referenced by a route come from the
  consumer's own environment or the cluster's sealed secrets.
