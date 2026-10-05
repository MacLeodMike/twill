# Twill T1 (Registry + `twill` CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `twill` workspace registry service and the `twill` CLI — the T1 milestone: document watch, resolve, discovery, statusReport (provider polling deferred), fingerprint-reject, Workspace kind only.

**Architecture:** A single Node process (`src/registry/`) serves the HTTP surface over a YAML document directory it watches; a separate `twill` CLI binary (`src/cli/`) is the first consumer. Documents are one YAML file per document under `documents/<Kind>/<name>.yaml`. Claims are schema-reserved but **not implemented** in T1 (501 with a clear message); the writable overlay is likewise deferred until the first cold workspace exists.

**Tech Stack:** TypeScript (strict), Node 26 built-ins (`node:http`, `node:fs`, `node:test`), `yaml` for parsing, `tsx` for dev execution. No web framework — `node:http` is sufficient for this surface.

**Specs (authoritative — read before implementing):**
- `docs/superpowers/specs/2026-10-04-twill-fabric-core.md` (rev 10) — the protocol
- `docs/superpowers/specs/2026-10-04-twill-workspace.md` (rev 9) — the Workspace kind + registry surface

## Global Constraints

From the specs — every task's requirements implicitly include these:

- **Envelope closed shape** (core §3): `apiVersion`, `kind`, `metadata{name,labels}`, `spec{owner,routes,<kindname>,parent}`, `status`. `spec.` top level carries exactly four keys: `owner`, `routes`, `<kindname>`, `parent`.
- **Six kinds, protocol-fixed** (core §10.2): `Workspace`, `Card`, `Claim`, `MCPServer`, `Skill`, `AgentProfile`. T1 implements loaders/status for `Workspace` only; other kinds parse as inert (`resolvable: false`).
- **apiVersion** (core §3): `twill.bitwiseoperations.ca/v1alpha1`. Unknown `apiVersion` → document inert, **not** a load error.
- **Durable id** (core §4.3): storage-backed kinds → `spec.<kindname>.storage.id`; others → `spec.<kindname>.id`. Workspace is the only storage-backed kind in v1alpha1.
- **Fingerprint** (core §4.3, §8.3): `spec.workspace.storage.fingerprint`, REQUIRED for Workspace; child's equals parent's.
- **Selectability** (core §7): `selectable := ready OR provisionable`. Order before readiness: a lower route is selected only if every earlier matching route was not selectable. Matching is not a health check.
- **Matching** (core §7.1): exact string equality on each key `match` specifies; consumer declares `agentLocation`, `agentKind`, `principal` (all required, possibly empty). Empty string in a `match` value is a violation. `""` consumer principal is anonymous and matches only routes that don't list `principal`. No wildcards.
- **Workspace route types** (workspace §4, kind-owned closed enum): `local`, `ssh`, `k8s-exec`. Unknown `type` at resolution = per-route invalid.
- **Descriptor pinned shape** (core §7.2): `{kind, name, durable_id, route, status}` with `route` a verbatim copy from the stored document; `status` six fields `{ready, provisionable, claimedBy, progress, asOf, source}`.
- **Status defaults** (core §8): never-observed Workspace ⇒ `{ready: false, provisionable: true, claimedBy: [], progress: "no provider report yet", asOf: <null>, source: "cached"}`. `claimedBy` is document-derived (empty in T1 — no claims) and never defaulted.
- **Resolve result** (core §7): exactly three shapes — `Attached` | `NoMatch` | `Unreachable` — distinguishable by a top-level discriminator field.
- **claims deferred**: `POST/PATCH .../Claim/<name>` and `GET .../claims` return HTTP 501 `{"error": "claims unimplemented in T1 milestone", "milestone": "T2"}` while `Claim` documents still load, affect lineage (§8.3 fingerprint sharing is storage-backed-only, so Claims don't), and appear in discovery.

## Review Focus

Inputs the spec implies but no single task's happy-path test covers — each gets a test in the owning task:

1. **A document directory containing a non-YAML file or a subdirectory** (operator dropped a README in): must be ignored with a log line, never crash the loader. → tested in Task 2.
2. **A YAML document that parses but has the wrong `apiVersion` or no `kind`** (hand-edited): must load as inert (`resolvable: false`), not a set-level rejection. → tested in Task 2.
3. **An SSH route on a `local`-only consumer, or a `match` with an empty-string value** (§7.1 violation): matching must treat empty-in-match as never matching rather than crashing. → tested in Task 4.
4. **A `resolve` call racing a reload that flips the set to last-good** (watch fires mid-resolve): the resolve completes against one consistent snapshot, never a torn read. → tested in Task 5.
5. **A `statusReport` arriving for a document that does not exist / wrong kind**: 404 with a clear body, cache untouched. → tested in Task 6.

---

### Task 1: Project scaffold + workspace fixture

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts` (or use `node:test` — decide here, pin in `package.json`)
- Create: `fixtures/documents/Workspace/workstation-repos.yaml`
- Create: `fixtures/documents/Workspace/payments-repo.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable `npm test` harness; two canonical fixture documents used by every later task's tests. Fixture `workstation-repos.yaml` MUST be the spec §2 example verbatim (name `workstation-repos`, `owner: user:example`, `storage.id: ws_01J8Z4-workstation-repos`, `fingerprint: vol-2c4f1a`, two routes: `local` match `{agentLocation: workstation}` path `~/repos`, `ssh` match `{agentLocation: cluster}` address `workstation` path `/data/repos`). `payments-repo.yaml` is the §2.2 child's parent: name `payments-repo`, `storage.id: ws_01J8Z4-payments-repo`, same fingerprint `vol-2c4f1a`, single `local` route.

- [ ] **Step 1: Initialize the package**

`package.json` with `"type": "module"`, engines `node >= 22`, devDependencies `typescript`, `tsx`, `vitest` (and `@types/node`), dependency `yaml`. Scripts: `"test": "vitest run"`, `"dev": "tsx watch src/registry/server.ts"`, `"cli": "tsx src/cli/twill.ts"`. `tsconfig.json`: `"strict": true`, `"module": "nodenext"`, `"target": "es2022"`, `"moduleResolution": "nodenext"`.

- [ ] **Step 2: Verify the scaffold runs**

Run: `npm install && npx vitest run --passWithNoTests`
Expected: exits 0.

- [ ] **Step 3: Write the two fixtures**

Files per the Interfaces block above, YAML matching the spec examples exactly (routes use the workspace §4 field vocabulary: `local` → `path`; `ssh` → `address`, `path`).

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts fixtures/
git commit -m "t1: project scaffold + workspace fixtures"
```

---

### Task 2: The document loader (parse + envelope validation + inert marking)

**Files:**
- Create: `src/registry/document.ts`
- Create: `src/registry/loader.ts`
- Test: `src/registry/loader.test.ts`

**Interfaces:**
- Consumes: fixture files from Task 1.
- Produces:
  - `type FabricDocument` — the parsed envelope: `{ apiVersion: string; kind: Kind; name: string; labels: Record<string,string>; owner: string; routes: Route[]; kindSpec: Record<string,unknown>; parent?: {kind: string; name: string}; resolvable: boolean; sourcePath: string; raw: unknown }`
  - `type Kind = "Workspace" | "Card" | "Claim" | "MCPServer" | "Skill" | "AgentProfile"`
  - `loadDirectory(dir: string): { documents: FabricDocument[]; problems: LoadProblem[] }` — synchronous walk of `documents/<Kind>/<name>.yaml`, one document per file, non-YAML entries skipped with a `LoadProblem {path, reason}` entry.
  - `durableIdOf(doc: FabricDocument): string | null` — §4.3 rule (Workspace → `spec.workspace.storage.id`; else `spec.<lowercase kind>.id`; missing → `null`).

Behavior pins from the spec:
- A file that fails YAML parse, or parses to a non-object → `LoadProblem`, document not included, other files still load (never crash the batch).
- A parsed document missing `kind`, with an unknown `kind`, wrong `apiVersion`, or missing `spec.owner` → included, `resolvable: false` (inert), with the reason noted. `durableIdOf` still computed when possible.
- A `Workspace` whose `spec.workspace.storage.fingerprint` is missing → inert (kind-required field absent).
- Subdirectories or non-`.yaml` files under `documents/` are skipped (Review Focus #1).

- [ ] **Step 1: Write the failing tests**

In `loader.test.ts`: load `fixtures/documents` → 2 documents, both resolvable, `durableIdOf(workstation-repos) === "ws_01J8Z4-workstation-repos"`. Plus three focused tests: non-YAML file ignored (Review Focus #1), bad-`apiVersion` document loads inert (Review Focus #2), missing `fingerprint` Workspace loads inert.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/loader.test.ts`
Expected: FAIL — `loadDirectory` not defined.

- [ ] **Step 3: Implement `document.ts` + `loader.ts`**

`loadDirectory` reads `documents/<Kind>/<name>.yaml` entries (accept either `documents/<Kind>/<file>.yaml` or flat `documents/<file>.yaml` for a single-kind store — pick one, document the choice in a comment), parses with `yaml`, validates per the behavior pins. One pass; no caching here.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/registry/loader.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/document.ts src/registry/loader.ts src/registry/loader.test.ts
git commit -m "t1: document loader with envelope validation and inert marking"
```

---

### Task 3: Lineage computation + the §8.3 load-reject rule

**Files:**
- Create: `src/registry/lineage.ts`
- Test: `src/registry/lineage.test.ts`

**Interfaces:**
- Consumes: `FabricDocument`, `durableIdOf` from Task 2.
- Produces:
  - `ancestorSet(doc: FabricDocument, byName: Map<string, FabricDocument>): Set<string>` — self-inclusive: contains `doc`'s `kind/name` key plus every transitive `spec.parent` key, whether or not the parent is present (keys are `"<Kind>/<name>"`).
  - `rejectCheck(documents: FabricDocument[]): { rejected: boolean; reason?: string }` — the §8.3 rule over the whole set.

Behavior pins (§8.3):
- **Fingerprint collision without lineage** → reject: two storage-backed documents with equal populated `storage.fingerprint` and different `storage.id`s, whose ancestor sets do not intersect **at a document present in the set**. Intersecting ancestor must be loaded; two documents citing the same *missing* parent share no lineage.
- **Duplicate durable id** → reject, always.
- **Cycle rejection precedes lineage computation** (§4.2): a document whose parent chain loops → reject with reason.
- Parent/child and siblings under one present root with equal fingerprints → accepted.

- [ ] **Step 1: Write the failing tests**

Construct `FabricDocument` fixtures in-memory (no filesystem): (a) workstation-repos + its child worktree sharing `vol-2c4f1a` → accepted; (b) two unrelated roots with equal fingerprint → rejected with a reason naming both; (c) two unrelated roots citing the same missing parent name → rejected (lineage requires presence); (d) duplicate `storage.id` → rejected; (e) a parent cycle (a→b→a) → rejected.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/lineage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lineage.ts`**

`ancestorSet` walks `spec.parent` up to the set root, tracking visited keys for cycle detection. `rejectCheck` groups storage-backed documents by fingerprint, checks durable-id duplicates across all documents, then applies the no-common-present-ancestor rule per group. Return the first violation found with a human-readable `reason`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/registry/lineage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/lineage.ts src/registry/lineage.test.ts
git commit -m "t1: lineage computation + §8.3 fingerprint load-reject"
```

---

### Task 4: Matching + status surface + the resolver

**Files:**
- Create: `src/registry/matching.ts`
- Create: `src/registry/status.ts`
- Create: `src/registry/resolver.ts`
- Test: `src/registry/resolver.test.ts`

**Interfaces:**
- Consumes: `FabricDocument`, `durableIdOf` (Task 2), lineage pass result (Task 3, used at a higher layer).
- Produces:
  - `matches(match: Record<string,string> | undefined, consumer: Consumer): boolean` — §7.1 exact-equality per specified key; `Consumer = { agentLocation: string; agentKind: string; principal: string }`.
  - `type StatusSurface = { ready: boolean; provisionable: boolean; claimedBy: ClaimedRef[]; progress: string; asOf: string | null; source: "live" | "cached" }` (core §8 shape).
  - `statusFor(doc: FabricDocument, cache: StatusCache): StatusSurface` — returns the cached provider report if present, else the Workspace never-observed default (`{ready:false, provisionable:true, claimedBy:[], progress:"no provider report yet", asOf:null, source:"cached"}`). `claimedBy` always `[]` in T1.
  - `type ResolveResult = { result: "Attached"; descriptor: AttachedDescriptor } | { result: "NoMatch" } | { result: "Unreachable"; errors: RouteError[] }` — the top-level `result` field is the discriminator the spec's three-shape rule pins.
  - `resolve(kind: Kind, name: string, consumer: Consumer, store: Store): ResolveResult` — implements the core §7 algorithm verbatim: no document → `NoMatch`; filter routes by `matches`; no surviving routes → `NoMatch`; in declared order, unknown `type` → collect error and continue, not selectable → collect error and continue, else return `Attached` with a descriptor whose `route` is the verbatim stored route and whose `status` is `statusFor`'s.

Behavior pins:
- The Workspace route-type enum is exactly `local | ssh | k8s-exec` (workspace §4).
- Empty string as a `match` value never matches (§7.1 violation → treat as no-match, Review Focus #3).
- Anonymous consumer (`principal: ""`) matches only routes that don't list `principal`.
- Never-observed default per Global Constraints (ready false, provisionable true).

- [ ] **Step 1: Write the failing tests**

Against the Task-1 fixtures with a stub `Store`: (a) workstation consumer resolving `workstation-repos` → Attached, route `type: "local"`; (b) cluster consumer → Attached with the `ssh` route; (c) unknown name → NoMatch; (d) consumer with `agentLocation: "mars"` → NoMatch (no route matches); (e) a route with `type: "bogus"` first and a valid matching `ssh` second → Unreachable only if the second is somehow not selectable, else Attached via the second (pins order-before-readiness and unknown-type-continue); (f) a `match` with an empty-string value → that route never matches (Review Focus #3).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three files**

`matching.ts` is ~15 lines. `status.ts` holds `StatusCache` as `Map<string, StatusSurface>` keyed by `kind/name` and the default. `resolver.ts` is the §7 algorithm transcription.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/registry/resolver.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/matching.ts src/registry/status.ts src/registry/resolver.ts src/registry/resolver.test.ts
git commit -m "t1: matching, status surface, resolver (core §7 algorithm)"
```

---

### Task 5: The registry store — watched directory, reload, last-good, snapshot consistency

**Files:**
- Create: `src/registry/store.ts`
- Test: `src/registry/store.test.ts`

**Interfaces:**
- Consumes: `loadDirectory`, `FabricDocument` (Task 2), `rejectCheck` (Task 3), `StatusCache` (Task 4).
- Produces:
  - `class RegistryStore` with `current(): Snapshot`, `reload(): void`, `health(): HealthReport`, `statusCache: StatusCache`, and `close(): void` (stops watchers).
  - `type Snapshot = { documents: FabricDocument[]; byName: Map<string, FabricDocument>; generation: number }` — an immutable snapshot; resolvers hold a `Snapshot`, so a reload mid-resolve never tears a read (Review Focus #4).
  - `type HealthReport = { documentSet: "current" | "stale"; rejectedAt?: string; reason?: string; warnings: Warning[] }`
  - `start(dir: string): RegistryStore` — performs an initial `reload()` and begins watching; reloads are debounced.

Behavior pins (core §8.3 + workspace §8):
- `reload()` runs `loadDirectory` + `rejectCheck`. On pass → swap in new snapshot, `documentSet: "current"`. On reject → keep the last-good snapshot, `documentSet: "stale"`, `rejectedAt` = now, `reason` from `rejectCheck`, log. Cold start with a rejected set → empty snapshot, `documentSet: "stale"`.
- Watcher: `fs.watch(dir, { recursive: true })`, debounce ~100ms into `reload()`. Tolerate `recursive` unavailability by watching per-kind subdirectories instead.
- Non-fingerprint warnings (orphan claims — none in T1 since claims are 501; leave the `warnings` array present but empty) live in `HealthReport.warnings`.

- [ ] **Step 1: Write the failing tests**

Use a temp dir per test (copy fixtures in, mutate, assert): (a) initial load good → `health().documentSet === "current"`, 2 documents; (b) append an aliasing pair (two unrelated roots, same fingerprint) → after watcher debounce, `documentSet === "stale"`, old snapshot still served (`current().documents` length still 2), `rejectedAt` set; (c) fix the file → back to `current`; (d) cold start on a directory whose fixtures are already an aliasing pair → empty snapshot, `stale`; (e) a `resolve` issued from a snapshot taken before a bad reload still resolves the old document (Review Focus #4 — hold the snapshot object across the reload).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `store.ts`**

The snapshot is the unit of atomicity: build the new one fully (parse → validate → lineage), then a single assignment swaps `this.snapshot`. Generation counter increments per accepted reload so a resolver can detect staleness if it wants (not required in T1).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/registry/store.test.ts`
Expected: PASS (5 tests). Watcher tests may need `await setTimeout(200)` after a file mutation — that is fine.

- [ ] **Step 5: Commit**

```bash
git add src/registry/store.ts src/registry/store.test.ts
git commit -m "t1: registry store — watched directory, last-good, snapshot consistency"
```

---

### Task 6: HTTP surface (`node:http`) — resolve, get, discovery, health, statusReport, claims 501

**Files:**
- Create: `src/registry/server.ts`
- Create: `src/registry/routes.ts` (HTTP routing, kept separate from the resolver)
- Test: `src/registry/server.test.ts`

**Interfaces:**
- Consumes: `RegistryStore` (Task 5), `resolve`, `Consumer` (Task 4), `durableIdOf` (Task 2).
- Produces:
  - `createServer(store: RegistryStore): http.Server` listening on `PORT` (default 8080) or an ephemeral port under test.
  - Endpoints, all under `/twill/v1alpha1`:
    - `GET /` → discovery: array of `{kind, name, durable_id, resolvable, parent?}` for every document, inert included (core §10.3 shape).
    - `GET /<kind>/<name>` → the stored document as JSON, 404 if absent.
    - `POST /resolve` with body `{kind, name, consumer: {agentLocation, agentKind, principal}}` → 200 with the `ResolveResult` (the `result` discriminator distinguishes the three shapes).
    - `POST /<kind>/<name>/statusReport` with body `{ready?, provisionable?, progress?, asOf?}` → merges into `store.statusCache` keyed `kind/name`; 404 when the document does not exist (Review Focus #5); `claimedBy` in a submitted body is ignored with a warning log (it's registry-derived).
    - `GET /health` → `store.health()`.
    - `POST /Claim/<name>`, `PATCH /Claim/<name>`, `GET /claims?...` → **501** with `{"error": "claims unimplemented in T1 milestone", "milestone": "T2"}`.
    - `PATCH /<kind>/<name>` (non-Claim) → **501** `{"error": "overlay writes unimplemented in T1 milestone"}` (overlay deferred per Global Constraints).

Behavior pins:
- Discovery's `resolvable` is §10.3's rule: the document is non-inert AND has `routes` non-empty.
- `statusReport` with an `asOf` absent stamps now (RFC 3339).
- All bodies are JSON; malformed JSON → 400 with `{"error": ...}`.

- [ ] **Step 1: Write the failing tests**

Boot the server on an ephemeral port against a fixture-backed store, then with `fetch`: (a) `GET /twill/v1alpha1` returns both fixtures with `resolvable: true`; (b) `POST /resolve` workstation/`workstation-repos` → 200, `result: "Attached"`, `route.type: "local"`; (c) `POST /resolve` unknown name → `result: "NoMatch"`; (d) `GET /twill/v1alpha1/Workspace/workstation-repos` → the document, `durable_id` derivable; (e) `POST .../statusReport` for a missing document → 404 (Review Focus #5); (f) statusReport for `workstation-repos` then `resolve` → descriptor's `status.progress` reflects the report; (g) `POST /twill/v1alpha1/Claim/x` → 501 with the milestone message.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `routes.ts` + `server.ts`**

A small router (method + path regex table) over `node:http`. No framework; the surface is seven endpoints. Read the body as UTF-8, JSON.parse, dispatch, serialize.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/registry/server.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/server.ts src/registry/routes.ts src/registry/server.test.ts
git commit -m "t1: HTTP surface — resolve/get/discovery/health/statusReport, claims 501"
```

---

### Task 7: The `twill` CLI — resolve, list, get, health

**Files:**
- Create: `src/cli/twill.ts`
- Test: `src/cli/twill.test.ts`

**Interfaces:**
- Consumes: the running server from Task 6 (integration via fetch against an ephemeral server, started by the test).
- Produces: a CLI invoked as `twill <command>`, with commands:
  - `twill resolve <kind> <name> [--location L] [--kind K] [--principal P]` — prints the descriptor JSON on Attached, `NoMatch`/`Unreachable` plainly on those.
  - `twill list` — table of discovery rows (kind, name, resolvable, durable_id).
  - `twill get <kind> <name>` — document JSON.
  - `twill health` — the health report.
- Flags: `--registry <url>` (env `TWILL_REGISTRY`, default `http://localhost:8080/twill/v1alpha1`); `--agent-kind` default `twill-cli/0.1.0`; `--agent-location` default `workstation`; `--principal` required on `resolve`.

Behavior pins:
- Nonzero exit codes: Attached 0, NoMatch 2, Unreachable 3, HTTP/transport error 1.
- Output is JSON for `resolve`/`get`/`health` (pipe-friendly), table for `list`.

- [ ] **Step 1: Write the failing tests**

Spawn the CLI with `tsx` against a test server: `twill resolve Workspace workstation-repos --principal user:test` exits 0 and its stdout parses to a descriptor with `route.type === "local"`; `twill list` shows both fixtures; an unknown name exits 2.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/cli/twill.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `twill.ts`**

Hand-rolled arg parse (no commander dependency — four commands). Each command builds the fetch call against `--registry` and prints per the output pins.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/cli/twill.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/twill.ts src/cli/twill.test.ts
git commit -m "t1: twill CLI — resolve/list/get/health"
```

---

### Task 8: Wire-up — real fixtures against a live registry end-to-end, plus the compose deliverable

**Files:**
- Modify: `package.json` (`"start": "tsx src/registry/server.ts"`)
- Create: `fixtures/documents/Workspace/payments-repo-feat-x.yaml` (the §2.2 worktree child, `storage.id: ws_01J8Z4-payments-repo-feat-x`, `fingerprint: vol-2c4f1a`, `parent: {kind: Workspace, name: payments-repo}`)
- Create: `deploy/compose.yml`
- Create: `README.md` (how to run)

**Interfaces:**
- Consumes: everything.
- Produces: a documented `npm start` + `npm run cli` flow that a fresh checkout can run, and a `deploy/compose.yml` from which `docker compose up` on a plain docker host (workspace §9.1) gives a working registry.

`deploy/compose.yml` contents — one service bind-mounting the documents directory read-only:

```yaml
services:
  twill-registry:
    build: ..
    volumes:
      - ../fixtures/documents:/documents:ro
    ports:
      - "8080:8080"
    restart: unless-stopped
  # Optional tier-2 provider (workspace §9.1): uncomment to POST
  # statusReport {ready: true} per workspace every 30s so the status
  # surface is truthful rather than the never-observed default.
  # twill-static-provider:
  #   build: ../providers/static
  #   environment: { TWILL_REGISTRY: "http://twill-registry:8080" }
  #   restart: unless-stopped
```

The build context requires a `Dockerfile` at repo root (create it as part of this task: `node:26-alpine`, `npm ci`, `CMD ["node", "--import", "tsx", "src/registry/server.ts"]` or equivalent). The commented sidecar documents the tier-2 option — building `providers/static` is **not** part of T1; the comment pattern is the deliverable.

- [ ] **Step 1: Regression run**

Run: `npx vitest run`
Expected: all tasks' tests PASS (~26).

- [ ] **Step 2: Live smoke (manual, documented in README)**

`npm start` on one shell; in another `npm run cli -- resolve Workspace workstation-repos --principal user:example` prints the local-route descriptor. Drop a bogus-fingerprint document into `fixtures/documents/Workspace/`, watch the registry log the rejection and `twill health` show `stale`, remove it and watch recovery.

- [ ] **Step 3: Compose smoke**

Run: `docker compose -f deploy/compose.yml up --build -d && curl -s localhost:8080/twill/v1alpha1/health`
Expected: `{"documentSet": "current", ...}`.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json Dockerfile deploy/compose.yml fixtures/documents/Workspace/payments-repo-feat-x.yaml
git commit -m "t1: e2e wiring + README + compose deployment"
```

---

## Self-review notes (checked before saving)

- **Spec coverage:** T1 milestone items from workspace §10 — registry process ✓ (T5+T6), document watch ✓ (T5), resolve ✓ (T4+T6), discovery ✓ (T6), fingerprint reject ✓ (T3+T5), statusReport push ✓ (T6; provider *polling* is T2+), Workspace kind only ✓, first consumer `twill` CLI ✓ (T7). Claims create/read and the writable overlay are explicitly deferred (see Global Constraints + T6's 501s) per the pre-plan decision.
- **Type consistency:** `ResolveResult.result`, `StatusSurface`, `Snapshot`, `durableIdOf`, `ancestorSet` are named identically across tasks; T6 consumes T4's `resolve`/`Consumer` and T5's `RegistryStore`; T7 consumes T6's HTTP surface only.
- **Proportion:** ~8 tasks, plan is structured rather than code-heavy; bodies left to the implementer except the §7 algorithm (pinned verbatim) and the never-observed default values (spec-fixed).
