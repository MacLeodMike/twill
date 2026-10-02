# Twill: a shared agent work fabric

**Status:** Draft, pre-implementation
**Date:** 2026-10-02
**Authors:** example + pi (design conversation in pi session)
**Target repo:** `twill` (currently `~/repos/pi-assistant`, to be renamed)

---

## 1. What this is

Twill is an agent **work fabric**: a small set of in-cluster services and an extension
ecosystem that replace `hermes-agent` + `hermes-webui` as example's personal
assistant, and connect that assistant to the pi coding-agent workflow.

The framing decision that drives everything else:

> **One shared work fabric that all agents — assistant, coding agents, scheduled jobs —
> read and write.** The assistant is the most social surface on it, not the center of it.

Twill has four fabric primitives:

| Primitive | What it is | Backed by |
|---|---|---|
| **Conversations** | Durable, forkable agent transcripts | `@earendil-works/pi-durable` (harness, SQLite storage) |
| **Memory** | Long-term persona/peer memory | Honcho (existing deployment) |
| **Work items** | Cross-repo kanban cards | New `twill-kanban` service (small) |
| **Workspaces** | Named, resolvable execution environments | Simple registry service + `ExecutionEnv` implementations |

These four are separable services/projects. Every agent is just a handler attached to
some subset of them. This is the shape hermes *should* have had: hermes's subsystems
(agent loop, plugin system, sandbox backends, crontask, kanban, memory) become separable
components that only know about their own fabric object.

### 1.1 Positioning

- **Replaces:** `hermes-agent` (cluster + local), `hermes-webui`.
- **Not replacing:** `pi` the coding agent, `herdr`, `honcho`, `bifrost`, the flux
  GitOps repos. All are consumers/neighbors of the fabric.
- **Built on:** pi-durable (`@earendil-works/pi-durable` v1.0.0, published 2026-10-01,
  MIT), pi-ai, chord. TypeScript, one deployable process + a SQLite file.

### 1.2 Why not X

| Option | Verdict |
|---|---|
| **nanobot** | ~70% feature match (WebUI, cron, channels, memory). Rejected: features are bundled, not extensions; gateway singleton (no crash durability); Python not TypeScript. |
| **OpenClaw** | Same gateway-channel-monolith pattern; documented release regressions; ClawHub security incidents. |
| **Stay on hermes** | The webui imports and re-implements the entire agent loop; 800-line config where ~90% is dead weight; two separate agent loops (CLI + webui) is the thing we most want gone. |
| **Build on raw pi** | pi is a coding agent: one user, interactive, terminal. pi-durable is the framework; pi is not. |

---

## 2. Design principles

1. **Minimal core, everything else is an extension.** Harness + storage + task runtime is
   the core. Web search, honcho, servarr tools, kanban, cron, discord are extensions, each
   in its own package/repo. Mirrors pi's model (19 packages his setup installs, each doing
   one thing).
2. **One agent loop, many surfaces.** The loop lives in the harness process. Webui, future
   TUI, cron triggers, and (later) messaging channels are all clients holding submissions
   on conversations. The hermes-webui problem (re-implementing the loop) is impossible by
   construction.
3. **Conversations are durable and addressable.** Every surface works with the same SQLite
   transcripts. Crashes, pod restarts, and laptop sleep don't lose work. `requestId`
   makes submissions exactly-once; `harness.resume()` picks up after a crash.
4. **Resolve and route, don't co-locate.** The fabric stores *registries* (workspaces,
   cards). Compute and storage attach wherever they are: cluster PVC, workstation dir,
   TrueNAS. The fabric owns no data except its three SQLite files.
5. **CRD-forward schemas from day 1.** v1 config is a YAML file in k8s resource shape.
   The v2 fabric-operator reads the same documents as CRDs. No schema migration.
6. **Lazy about automation.** v1 has no workflow engine, no auto-claimers, no leases. A
   card in `ready` sits there until a herdr plugin (or user) claims it. Add machinery when
   the manual loop hurts.

---

## 3. The fabric trio (in-cluster services)

Three processes, three SQLite files, always-on. In v1 they can be three containers in
one pod or one process with three sub-services — decide at implementation; the API
boundaries are what matter.

### 3.1 Twill harness (`twill-harness`)

The pi-durable harness. Owns the conversation SQLite DB and the extension registry.

- **Storage:** `openNodeSqliteStorage("/data/twill.sqlite")`, PVC-backed. One process
  owns it (pi-durable's guarantee).
- **Models:** pi-ai custom OpenAI-compat provider pointed at the bifrost gateway
  (`https://llm-gateway.tailnet.example.test/v1`) with a `vk-twill` virtual key.
  - *Verification needed:* confirm pi-ai exposes a custom/base-URL OpenAI provider (the
    README only documents built-ins; user's pi models.json proves pi itself supports it).
- **Resume:** `harness.resume()` on start; pod restarts lose nothing.
- **API to surfaces:** WebSocket/SSE endpoint exposing:
  - `listConversations()`, `getConversation(id)` (transcript view)
  - `submit(conversationId, input, requestId)` → submission stream
  - `watchConversation(id)` for streaming output
  - `abort(submissionId)`
- **Auth:** v1 private (Authelia-fronted, tailnet-only, or per-user token). v2: OIDC SP.

### 3.2 Twill kanban (`twill-kanban`)

The cross-repo work ledger. This is the piece no existing tool does.

**Rationale:** Forgejo issues are per-repo. Homelab work routinely spans ≥2 repos (app
repo + flux repo) and some work has no repo. Coding agents need a claim state machine;
assistants need to create cards from conversation; herdr needs to show the board.

**DB schema (SQLite):**
```sql
CREATE TABLE cards (
  id TEXT PRIMARY KEY,            -- e.g. "tw_01J8Z4-audio-corpus"
  title TEXT NOT NULL,
  body TEXT,                      -- markdown
  state TEXT NOT NULL,            -- idea | specced | ready | claimed | executing | review | done | blocked
  workspace_ref TEXT,             -- workspace name from registry (nullable: some cards have none)
  spec_ref TEXT,                  -- forgejo URL to spec file/range
  repo_refs TEXT,                 -- JSON array of forgejo repo URLs (multi-repo by design)
  owner TEXT NOT NULL,            -- fabric subject ("user:example")
  acl TEXT,                       -- JSON: shared-with subjects (v2)
  claimed_by TEXT,                -- herdr session id / pi run id, when executing
  claim_token TEXT,               -- the claimer's proof (random, matched on update)
  parent_card TEXT,               -- nullable: breakdowns (deploy spans repos -> children)
  labels TEXT,                    -- JSON array
  created_at INTEGER, updated_at INTEGER
);
```

**API (minimal REST):**
- `POST /cards` (create), `GET /cards`, `GET /cards/:id`, `PATCH /cards/:id`
- `POST /cards/:id/claim` (assigns claim_token, transitions to `claimed`)
- `POST /cards/:id/release` (back to `ready`), `POST /cards/:id/complete`

**State machine (dumb on purpose):**
`idea → specced → ready → claimed → executing → review → done | blocked`
- `claimed` + `executing` are separate: claim is atomic reservation, executing means the
  claimer actually has a pi session live. Lets the webui show "claimed but not started".
- No auto-transitions. Agents and humans move cards; the kanban enforces validity of
  transitions only.

### 3.3 Twill workspace registry (`twill-registry`)

The "resolve and route" service. See §4 — this is the design's load-bearing piece.

---

## 4. Workspaces (the CRD-forward schema)

A workspace is a **named, resolvable execution environment**, not a directory. Agents
resolve a name to an `ExecutionEnv` (pi-durable's `FileSystem + Shell` interface);
the fabric never hosts the files directly.

### 4.1 v1 config file (k8s-shape)

The registry loads this file. It is the future CRD, verbatim:

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata:
  name: workstation-repos
  labels:
    twill/workspace-class: git        # git | shell | media | data
spec:
  storage:                            # THE identity — env id, never changes once claimed
    id: ws_01J8Z4-workstation-repos   # durable; edit/write serialization keys on this
    fingerprint: ""                   # v2: volume UUID / machine-id hash, operator-verified
  owner: user:example          # ACL day one: subject string, not boolean
  routes:                             # ordered; first matching + reachable wins
    - match: {agentLocation: workstation}
      type: local
      path: /home/example/repos
    - match: {agentLocation: cluster}
      type: ssh
      address: workstation.tailnet.example.test
      path: /home/example/repos
    - match: {}                       # any agent: brokered (v2)
      type: agent
      agentRef: workstation-main
  profile:                            # what agents are told about the workspace
    hostname: workstation
    toolHints: [git, forgejo-api, pi]
    shellPolicy: full                 # full | readonly | none
status:                               # operator-owned in v2; never hand-edit
  reachable: []
  claims: []
```

### 4.2 Route types

| `type` | Implementation | Availability |
|---|---|---|
| `local` | Direct filesystem + shell (pi-agent-core's node env) | v1 |
| `ssh` | SSH exec + SFTP for file ops | v1 |
| `k8s-exec` | `kubectl exec` + PVC (in-cluster) | v1 |
| `agent` | Dial-out workspace-agent (brokered) | v2 — reserved in schema now |

`agent` is reserved, not implemented, in v1. When a workspace-agent (e.g. on a laptop
that's sometimes asleep) dials out to the fabric, the registry records its presence and
routes resolve to the brokered channel. No inbound holes, handles NAT/sleep.

### 4.3 The one correctness rule

pi-durable serializes `edit`/`write` by **env id + path**. Any two `ExecutionEnv`s that
resolve to the same physical storage MUST have the same `storage.id`. The registry's
`storage.id` is that value. Renaming a workspace does not change it. This is the single
load-bearing invariant of workspace routing.

### 4.4 Resolution semantics

1. Agent asks for workspace by name.
2. Registry returns the Workspace document (or a resolved route directly).
3. Agent walks `spec.routes` in order against its own `agentLocation` (self-declared).
4. First route that matches AND is reachable → instantiate the corresponding `ExecutionEnv`.
5. None reachable → work stays queued; card state unchanged.

Resolution is per-agent-location — the same workspace name can yield a local FS env for
pi on the workstation and an SSH env for the harness in-cluster, transparently.

---

## 5. Extensions (the ecosystem)

Each extension is a pi-durable package (npm/git), with its own repo when non-trivial.
All install into the harness's registry.

### 5.1 v1 extensions

| Package | What it does | Notes |
|---|---|---|
| `twill-ext-web-research` | Search + fetch tools (searxng MCP bridge or direct, crawl4ai markdown) | Read-only |
| `twill-ext-honcho` | Honcho memory | Store/recall tools; observed from the conversations themselves (see below) |
| `twill-ext-servarr` | Plex/Sonarr/Radarr/Lidarr/Tautulli management | 1:1 port of hermes's tool logic, from its plugin source |
| `twill-ext-cron` | Durable timers for scheduled jobs | pi-durable's timer/child-task machinery; replaces hermes's crontask |
| `twill-ext-kanban` | Kanban tools (`create_card`, `list_board`, `update_card`, `claim_card`) | Talks to twill-kanban service |
| `twill-ext-discord` | Read-only Discord log ingestion | Ingests as synthetic Honcho peer transcripts; v1 read-only |
| `twill-ext-forgejo` | Forgejo API tools (create repo, file issues, read PRs, commit) | Used by the "idea → repo + spec + card" flow |

### 5.2 The assistant's memory model

Mirrors the current hermes honcho config:

- Each user = a Honcho peer; the assistant = a Honcho AI peer.
- Every conversation is observed (messages + assistant messages) into the `example`
  workspace.
- Personas, dialectic reasoning (max level), hybrid recall — same knobs as the
  flux-app-llm hermes honcho values block.
- **Discord ingestion**: each Discord channel becomes a synthetic Honcho peer;
  ingested logs are its transcripts. "Catch me up on #model-talk" becomes a dialectic
  query over that peer. Read-only in v1.

### 5.3 Future extensions (named, not built)

- `twill-ext-channels` (Telegram/Discord write) — v2+
- `twill-ext-general-memory` (honcho-for-things: home network, movies) — separate project
- `twill-ext-image` (once pi-durable supports image input)
- `twill-operator` (k8s CRD controller for workspaces) — v2
- `twill-herdr` (herdr plugin — see §6)

---

## 6. The WebUI

**Goal:** hermes-webui's UX, shamelessly, on top of the harness's conversational API.
This is the highest-value single artifact and the primary interface.

### 6.1 What to take

- Three-panel layout: sessions sidebar (with tags/pins/`` menu), chat center,
  workspace file browser right panel (on-demand, not always-open).
- Composer footer: model picker, profile/persona picker, workspace picker, context ring.
- Tool-call cards (expandable, streamed).
- Light/dark themes plus accent skins.
- Persistent per-session composer draft.

### 6.2 What to replace

- **The entire backend.** No Python, no agent loop, no auth-database, no `.env` profile
  management. The webui is a client of the harness API only.
- **The frame stack.** hermes-webui is Python + vanilla JS. Twill's webui: keep vanilla
  JS if it keeps the port fast, or use the pi-durable vacation-demo's approach (a small
  React/TS app). Decide after 1 day of spike on "how much of hermes-webui's 170KB of
  frontend JS is directly reusable as-is." (If >60%: port, don't rewrite.)

### 6.3 Non-goals

- No session forking UI (use the API for now; UI later).
- No multi-user login flow in v1 (Authelia at the ingress is sufficient).
- No model/provider management UI (bifrost owns that).

---

## 7. The coding-agent handoff

The "cool I'd love to steer this from my phone" flow:

1. **Conversation**: user + assistant discuss an idea (webui).
2. **Assistant action**: calls `twill-ext-forgejo.create_repo`,
   writes the spec (using the superpowers format), commits, calls
   `twill-ext-kanban.create_card` linked to the spec.
3. **Card waits** in `ready`, `workspace_ref: workstation-repos`.
4. **User claims** (from `herdr` plugin or `twill-herdr claim`):
   - herdr plugin (or its CLI) creates a git worktree for `repo_refs[0]`, runs `pi` in it,
     records `claimed_by` + `claim_token` back to the kanban.
   - pi runs the SDD loop: read spec, plan, implement, review, commit.
   - On success: card → `review` (pi's `twill` pi-extension does this, or the herdr
     plugin when the pane closes cleanly).
5. **Away-from-desk steering**: card on the webui says "running in herdr session X" →
   user runs `herdr --remote` from laptop → steers the pi session directly. This is
   already how the user's existing flow works; twill just adds the link.

### 7.1 Herdr plugin shape (v2)

Per herdr's plugin docs (`herdr.dev/docs/plugins`, `herdr-plugin.toml` manifest, panes,
actions, startup hooks, socket API):

- **Pane**: "Twill Board" — lists ready/claimed cards from the kanban API.
- **Action**: "Claim Card" — runs the claim flow, opens a new herdr pane with pi running.
- **Startup hook**: re-attach `claim_token`s for cards claimed by this workstation's
  earlier herdr process.

No herdr core changes needed; plugins are executables driving herdr's full CLI/socket.

---

## 8. Deployment

### 8.1 In-cluster (v1)

- **Repo:** `flux-app-llm` (as the hermes chart lives there today). Eventually `flux-app-twill`.
- **Chart:** new `twill` chart in `~/repos/helm-charts`, modeled on hermes-pantheon but
  much smaller:
  - Deployment (1 replica, Recreate — RWO PVC), worker nodeSelector + dedicated toleration
  - PVC 4Gi (`itty-nfs-flashy`)
  - Service (ClusterIP for in-cluster access)
  - Tailscale LoadBalancer service (`tailscale` class) at `twill.tailnet.example.test`
  - ServiceMonitor + minimal PrometheusRule (process up, SQLite busy)
- **Image:** `ghcr.io/<user>/twill:vX.Y.Z` (multi-arch not needed) or forgejo-hosted.
- **Dependencies:** honcho (already deployed), searxng, crawl4ai, bifrost (already
  deployed), forgejo API token (SealedSecret).

### 8.2 Not-in-cluster (for others)

- Docker-compose: fabric trio + honcho + sqlite PVCs. `docker-compose up`.
- Does NOT require k8s; the `k8s-exec` route type just isn't available.

---

## 9. The v1 cut (milestones, in order)

Target: **replacing hermes end-to-end**. Each milestone is independently shippable.

### M1 — Harness skeleton (1–2 days)
- npm-install `@earendil-works/pi-durable`, wire bifrost provider (verify custom provider API)
- One conversation, SQLite storage on a PVC
- `submit()`/`wait()` WebSocket endpoint
- Deployment to cluster on the `hermes` worker nodes (before twill namespace exists)
- Exit: chat in a terminal against the service works; pod restart resumes

### M2 — WebUI (2–4 days) — *the flagship*
- hermes-webui UX clone on the harness API
- Sessions sidebar, composer footer, tool cards, context ring
- Exit: user lives in it for a day without missing hermes-webui (feedback loop)

### M3 — Memory + research (2 days)
- `twill-ext-honcho` with the example peer config (parity with hermes honcho)
- `twill-ext-web-research` (searxng + crawl4ai)
- Exit: memory works across sessions; "what did we discuss last week about X" works

### M4 — Kanban + forgejo (2–3 days) — *the differentiator*
- `twill-kanban` service (SQLite, the API in §3.2)
- `twill-ext-kanban` + `twill-ext-forgejo`
- "Create a repo + spec + card for this idea" flow works end-to-end from the webui
- Exit: a real idea → repo → card, claimed by pi manually

### M5 — Cron + servarr (2 days)
- Port the hermes crontasks the user actually uses
- Port the servarr tools
- Exit: hermes can be scaled to 0; cluster runs on twill

### M6 — Discord read-only + workstation SSH route (2–3 days)
- Discord ingestion as Honcho peer transcripts
- SSH `ExecutionEnv` backend; `workstation-repos` workspace callable from the harness
- Exit: "catch me up on #model-talk" + assistant can read workstation files

### M7 — herdr plugin (2 days)
- The section-7.1 plugin, minimal
- Exit: card → herdr pane with pi running in one keystroke

**Total v1 estimate: ~2–3 weeks of focused work.** (Single-developer pace with pi-driven
SDD.) Subsequent milestones (generalized memory, channels, operator, write-discord) are
their own specs.

---

## 10. Open questions (decide before implementation)

1. **Custom pi-ai provider.** Does pi-ai v1.x expose an OpenAI-compat base-URL provider
   path? (High confidence yes — pi itself talks to bifrost just fine — but the
   *programmatic* provider configuration path needs an API check at scaffold time.)
2. **WebUI frame stack.**: port hermes-webui's vanilla JS (~170KB, no build step) vs
   rebuild against pi-tui/vacation-demo patterns (React+TS). Spike for a day on how much
   of the frontend is directly reusable; port if >60%.
3. **Conversation <-> Honcho wiring.** Read path: is Honcho observation done by the
   *harness* (as a pi-durable extension hooking transcript commits) or by *twill-ext-honcho*
   (as tool calls)? The latter is simpler; the former is more honest. Prefer the latter
   in v1; consider a transcript hook in v2.
4. **WebSocket vs SSE** for the harness's surface API. The pi-durable vacation demo uses
   local TUI with process-in-process streams; for the webui across ingress, pick one.
   Lean SSE for streaming + REST for submit (simpler than WS's full-duplex needs).

---

## 11. Naming

- **twill** — the project, the fabric, the chart, the image. ("A weave pattern with
  diagonal ribs — strong, durable, workwear cloth." Warp/weft were both taken in adjacent
  tech.)
- **twill-harness / twill-kanban / twill-registry** — the trio, when split.
- **twill-ext-\*** — pi-durable extension packages (repo-per-non-trivial-extension).
- **twill-herdr** — the herdr plugin (later).
- Avoid: warp (warp.dev), weft (multiple agent-framework collisions).

---

## Appendix A — Session that produced this

Full design conversation between example and pi on 2026-10-02, in a pi session at
`~/repos/pi-assistant`. The architecture was co-designed; this spec is the distillation.
Key constraints and positions the user stated:

- Hermes features actually used, post-gateway-only cleanup: honcho memory, crontask,
  servarr tools, web-research, the webui as primary surface. Everything else (bedrock,
  docker sandbox variants, personalities, MoA) is dead weight.
- "It would be cool to access my coding sessions though, and respond to questions or
  prompt the coding agent to proceed." — away-from-desk follow-up.
- "Honcho for things, not just people" — the generalized-memory future project.
- "Multi-user would need guardrails around data sharing." — auth schema from day 1,
  Authelia as IdP later.
- Workspace tension: shared-with-pi workspace was convenient on a single machine; cluster
  isolation was painful; wants local-feeling surfaces with always-on availability.
- Herdr usage style: default config, `herdr --remote` for away-from-desk. No pane
  orchestration.
- `pi-assistant` → `twill` repo rename pending; session continues from the new path.
