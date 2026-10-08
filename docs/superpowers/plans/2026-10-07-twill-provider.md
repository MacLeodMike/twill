# Twill localhost provider — implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the localhost provider — the fabric's third party — per `docs/superpowers/specs/2026-10-07-twill-localhost-provider.md`: a library in the twill repo that polls claims, materializes local `git` workspaces, PATCHes children into the overlay, and pushes statusReports; exposed as a `twill provider` subcommand and an embeddable `startProvider()`; plus the one registry change (enable `PATCH /Workspace/<name>` overlay upsert).

**Architecture:** A `src/provider/` library (loop, claim matching, precondition executors, child-document construction) that consumes the registry only over HTTP. The CLI gains a `provider` subcommand. The registry gains Workspace-PATCH-through-overlay. `twill-pi` embeds `startProvider` in-process (a follow-on wiring task).

**Tech Stack:** TypeScript/Node, vitest, node:http fetch, `node:child_process` for `git`. No new runtime deps.

**Specs (authoritative):** `docs/superpowers/specs/2026-10-07-twill-localhost-provider.md` (this design), `2026-10-04-twill-fabric-core.md` §8/§9, `2026-10-04-twill-workspace.md` §6/§7/§8.

---

## Global Constraints

- **HTTP-only to the registry.** The provider NEVER imports the registry store; it uses `fetch`. (The CLI/subcommand lives in the same repo but the provider loop is a client.)
- **Route exact-match binding.** A claim is this provider's iff `spec.claim.route` deep-equals one of its configured routes. Filtering is client-side (registry returns all claims against the parent).
- **Deterministic children** (spec §5.3): child `name = <parent>-<worktreeName>`; `storage.id = <parent-id>-<worktreeName>`; `spec.parent` = parent; fingerprint = parent's; route copied with child `path`, `precondition` dropped, `match`/`type` preserved.
- **v1 precondition steps:** `gitClone`, `worktree` only. `pvcBind`/`remoteMkdir`/`mountCheck` → claim fails with `progress` naming the unsupported step.
- **Idempotent + serial-per-parent.** Re-poll of a fulfilled claim is a no-op; re-run of a `worktree` step on an existing worktree is a no-op. Serial queue per parent.
- **Cold-root claims** (no `worktreeName`): materialize the parent, report `ready:true` on the parent, no child.

## Review Focus

1. **A claim whose route doesn't match any configured route** → provider ignores it (no materialization, no statusReport). → Task 3.
2. **A `worktree` claim where the branch is checked out elsewhere** → step FAILs, statusReport `ready:false, progress` names it, NO child PATCHed. → Task 2.
3. **The deterministic child id is a pure function** — claiming the same worktree twice PATCHes the same child name/id (upsert, converges). → Task 4.
4. **`PATCH /Workspace/<child>` against a fingerprint colliding with an existing non-lineage doc** → registry rejects with 4xx, nothing persisted. → Task 1.
5. **Cold-root claim (no worktreeName)** → parent materialized, `ready:true` on parent, no child document. → Task 3.
6. **End-to-end against a real registry**: POST claim → provider fulfills → child in overlay + `ready` → consumer's `resolve(Workspace, <child>)` returns the route. → Task 5.

---

### Task 1: Enable `PATCH /Workspace/<name>` overlay upsert (the registry capability)

**Files:**
- Modify: `src/registry/routes.ts` (the 501 at the `/<Kind>/<name>` PATCH branch, ~line 190)
- Modify: `src/registry/store.ts` (`appendOverlay` if the write seam needs a kind-general path)
- Test: `src/registry/overlay.test.ts` (or routes test)

**Interfaces:**
- Consumes: `RegistryStore.appendOverlay(doc)` (existing — validates merged set through `rejectCheck` before append, writes nothing on violation).
- Produces: `PATCH /twill/v1alpha1/<kind>/<name>` for non-Claim kinds: parse the YAML/JSON body into a document, `store.appendOverlay`, return the stored document (200) or the rejection error (409/400). Claim PATCH stays release-only (T2a's rule unchanged).

Behavior pins:
- A PATCH whose merged result violates §8.3 (fingerprint collision without lineage, duplicate durable id, parent cycle) → 409 with the error, overlay untouched (Review Focus #4).
- Upsert semantics: PATCH against a not-yet-existing name creates the document.
- Claim documents still route through the release-only path, not this.

Gate: `npx vitest run` green (TDD: failing test for a Workspace upsert + a collision-reject first).

---

### Task 2: Precondition executors (`gitClone`, `worktree`)

**Files:**
- Create: `src/provider/preconditions.ts`
- Test: `src/provider/preconditions.test.ts`

**Interfaces:**
- Produces:
  - `runPrecondition(step, ctx: {claimParameters: Record<string,string>}): Promise<{ok:true, path?: string} | {ok:false, error: string}>` — executes one step, substituting `{{claim.parameters.branch}}` / `{{claim.parameters.worktreeName}}` into string fields.
  - `gitClone({url, ref}, workDir)`: clone if absent; if present, fetch + verify `ref` matches (no-op on match, ff if clean, FAIL on dirty/diverged).
  - `worktree({repo, branch, base?}, workDir)`: `git worktree add` idempotently (existing worktree for the branch = no-op); FAIL on branch-checked-out-elsewhere.
  - Unsupported step types → `{ok:false, error: "unsupported precondition step: <type>"}`.

Behavior pins:
- All git via `node:child_process` `execFile` (no shell); capture stderr for error messages.
- `worktree` FAIL when the branch is checked out elsewhere (Review Focus #2).
- Parameter substitution is registry-implementation-owned (spec §7): `{{claim.parameters.X}}`.

Gate: vitest green against tmp git repos (init bare + clone fixtures in a tmpdir).

---

### Task 3: The provider loop + claim matching

**Files:**
- Create: `src/provider/loop.ts`, `src/provider/match.ts`
- Test: `src/provider/loop.test.ts`

**Interfaces:**
- Consumes: `runPrecondition` (Task 2); registry HTTP surface (claims GET, Workspace PATCH from Task 1, statusReport POST).
- Produces:
  - `interface ProviderConfig { registry: string; routes: Route[]; parents: string[]; pollIntervalMs?: number }` — `routes` = verbatim route objects this provider owns; `parents` = parent workspace names it polls.
  - `startProvider(config): { stop(): void }` — the embeddable entry point; runs the poll loop.
  - `isMine(claimRoute: Route, mine: Route[]): boolean` — deep-equal route match (Review Focus #1).
  - The loop: for each parent, `GET /claims?parent=Workspace/<p>&includeReleased=false` → filter `isMine(spec.claim.route)` → serial per-parent queue → fulfill.

Fulfillment (spec §5):
- Parent statusReport `ready:false, progress:"provisioning …"`.
- Cold-root claim (no `worktreeName`): run parent preconditions, `ready:true` on parent, no child (Review Focus #5).
- Worktree claim: run preconditions, build + PATCH the child (deterministic rules), child statusReport `ready:true`, final parent statusReport restoring state.
- Failure → statusReport `ready:false, progress:"<why>"`, no child.

Behavior pins:
- Serial per parent; two parents may fulfill concurrently.
- Idempotent: an already-fulfilled claim (child exists + ready) is skipped.

Gate: vitest green against an in-process real registry server (store + createServer, like the CLI test harness) + tmp git fixtures.

---

### Task 4: Child document construction (deterministic rules)

**Files:**
- Create: `src/provider/child.ts`
- Test: `src/provider/child.test.ts`

**Interfaces:**
- Produces: `buildChildDocument(parent, claim, childPath): FabricDocument` implementing spec §5.3 verbatim:
  - `metadata.name = <parent.name>-<parameters.worktreeName>`
  - `spec.workspace.storage.id = <parent.storage.id>-<worktreeName>`
  - `spec.parent = {kind:"Workspace", name: parent.name}`; fingerprint = parent's
  - `routes` = claim route copied, `path` → childPath, `precondition` dropped, `match`/`type` preserved exactly.

Behavior pins:
- Deterministic: same (parent, worktreeName) → same name + id (Review Focus #3). A duplicate claim upserts, not duplicates.
- The constructed child passes §8.3 lineage (parent present → ancestor sets intersect → no fingerprint-collision reject).

Gate: vitest green (name/id purity, lineage acceptance against a real store).

---

### Task 5: `twill provider` subcommand + end-to-end

**Files:**
- Modify: `src/cli/twill.ts` (add `provider` subcommand)
- Create: `src/provider/cli.ts` (or inline); `src/provider/e2e.test.ts`

**Interfaces:**
- CLI: `twill provider --config <file>` (config: registry URL, routes, parents, poll interval) — hand-rolled like the rest of the CLI; boots `startProvider`, logs fulfillments, runs until SIGINT.
- E2E (Review Focus #6): fixture registry with a cold local workspace → consumer POSTs a claim (the CLI's claim command) → provider fulfills → child appears in `GET /Workspace/<child>` with `ready:true` → consumer `resolve(Workspace, <child>)` returns the route with the child path.

Behavior pins:
- The subcommand is a thin wrapper over `startProvider` (the embeddable API is the same one twill-pi will use).
- Graceful shutdown on SIGINT (stop the loop, let in-flight fulfill finish or abort cleanly).

Gate: vitest green incl. the E2E; `npx tsc --noEmit` clean.

---

### Task 6: README + twill-pi embedding seam documented

**Files:**
- Modify: `README.md` (provider section: what it is, the config shape, `twill provider`, the embedded note)
- Document: the `startProvider` export as the twill-pi integration seam.

Gate: docs accurate; the `startProvider` signature in README matches `loop.ts`.

---

## Follow-on (separate repo, noted not built here)

- **twill-pi embedding**: `twill-pi` imports `startProvider` and runs it in-process when the registry is local — closing the homelab one-install story. Tracked as a twill-pi task.
