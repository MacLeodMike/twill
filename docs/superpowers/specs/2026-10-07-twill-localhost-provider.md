# Twill localhost provider — design

**Date:** 2026-10-07
**Status:** draft — proposed
**Specs consumed:** `2026-10-04-twill-fabric-core.md` (rev 10), `2026-10-04-twill-workspace.md` (rev 10). This document specifies the **first provider implementation**; it changes no protocol.

## 0. One sentence

A localhost provider — a small loop that polls the registry for claims against the workspaces it owns, materializes them with local `git` (clone/worktree), and reports status back — shipped as a library in the twill repo and embedded in `twill-pi`, so the homelab user gets registry + provider from one install with no separate daemon.

## 1. Why

The fabric has a consumer (twill-pi's resolve/attach/claim) and a registry, but **no provider** — nothing answers a claim. Without it the claim loop is inert: `twill_workspace_claim` POSTs a claim and polls forever, and no child workspace is ever materialized. The provider is the missing third party, and the first concrete proof that the claim-and-poll contract closes. Its product is materialization: a real worktree on local disk and a child document in the overlay.

## 2. Where it lives and how it runs

**Code home: the twill repo** (`src/provider/`), a library reusing the registry's wire types, claim parsing, and document store. Two entry points over the same library:

- **`twill provider` CLI subcommand** — a standalone long-running process (the shape an in-cluster deployment uses later).
- **`startProvider(opts)` export** — `twill-pi` embeds this in-process so the homelab user who installs the pi extension gets a provider with no separate daemon.

The pi plugin does not *become* the provider; it hosts the runtime-agnostic loop. The loop is pure protocol — it knows claims, routes, documents, and `git`, and nothing about pi. A future hermes adapter or k8s controller uses the same library (or re-implements the contract); nothing here is pi-shaped.

## 3. The party boundary is kept honest

The provider talks to the registry **only over HTTP** — `GET /claims?parent=...`, `PATCH /Workspace/<child>`, `POST /.../statusReport` — the exact bytes any third-party provider would exchange. It must not reach into the store directly. This is the point of the three-party split: the dogfood exercises the real protocol, not an in-process shortcut that would let the claim machinery be decorative.

## 4. The provider↔document binding (the one open decision)

The registry's own config states which provider handles which workspaces (workspace §9.2: "deployment-configured"). The provider config names:

- **`routes`** — the exact route objects it owns (verbatim `local` routes). A claim is *this provider's* iff `spec.claim.route` exact-matches one of these (deep-equal on the route object). This is the filter on the client side (T2a left route-match to the provider).
- **`parents`** — the set of parent workspace names it serves (or matched by the `twill/provider` label; v1: explicit enumeration in config, label-matching as an accepted convenience).

A provider only polls `GET /claims?parent=Workspace/<p>` for parents it is bound to, and only fulfills claims whose route it owns. Two providers backing one fingerprint never both materialize because each owns a *distinct route object* and filters on exact route match — the claim's verbatim route copy is the binding.

## 5. The fulfillment loop (all from workspace §6)

For each claim it owns (un-released, route matches):

1. **Mark provisioning**: `POST /twill/v1alpha1/Workspace/<parent>/statusReport` with `ready:false, progress:"provisioning <worktreeName>"`.
2. **Run the route's `precondition` steps** (workspace §7 vocabulary), substituting `{{claim.parameters.branch}}` / `{{claim.parameters.worktreeName}}` from the claim into `worktree` steps. v1 implements the two local steps:
   - `gitClone {url, ref}` — clone/fetch; no-op on match, ff if clean, FAIL on dirty/diverged.
   - `worktree {repo, branch, base?}` — idempotent `git worktree add`; FAIL on branch-checked-out-elsewhere.
   Steps the provider doesn't implement (`pvcBind`, `remoteMkdir`, `mountCheck`) are rejected: the claim fails with a statusReport `progress` naming the unsupported step — the provider must not pretend to materialize what it can't.
3. **On success, PATCH the child document into the overlay** (deterministic per §6.4):
   - `metadata.name` = `<parent-name>-<worktreeName>`
   - `spec.workspace.storage.id` = `<parent-storage.id>-<worktreeName>` (pure function — a duplicate claim re-yields the same child id)
   - `spec.parent` = the parent workspace; `fingerprint` = the parent's
   - `routes` = the claim's route copied, `path` replaced with the materialized child path, `precondition` dropped; `match`/`type` preserved exactly
   - `POST .../Workspace/<child>/statusReport` with `ready:true`
   - Final parent statusReport restoring the parent's own state.
4. **Cold-root claims** (no `worktreeName`): no child — materialize the parent, report `ready:true` on the parent, consumer keeps polling the parent's name.
5. **Failure**: statusReport with `ready:false, progress:"<why>"` (clone failure, dirty tree, unsupported step). The claim stays for operator visibility; the consumer's timeout releases it.

## 6. Concurrency & idempotence

- Claims are fulfilled serially per parent (a simple in-process queue) to avoid two materializations racing the same worktree path.
- Everything is idempotent: re-polling a fulfilled claim is a no-op (the child already exists and is `ready`); re-running a `worktree` step on an existing worktree is a no-op. The deterministic child name/id make a duplicate claim converge, not diverge.
- The provider is a single process; no cross-process locking in v1 (the twill-pi-embedded case is one provider per workstation).

## 7. What this does NOT do

- No `k8s-exec`, `pvcBind`, `remoteMkdir`, `mountCheck` materialization (cluster shapes — T3+, different provider).
- No provider discovery, no `status:` controller, no Authelia (§10 deferred).
- No claim GC, no RWO lease mechanics (§11 v2).
- Not a sandbox: precondition steps run real `git` on the provider host with the provider's credentials.

## 7.1 A registry capability this depends on (must land first)

The provider's fulfillment step PATCHes the materialized child Workspace into the overlay (§5 step 3). Today the registry returns **501 for `PATCH /Workspace/<name>`** — the T2a overlay write seam exists but is exposed only for Claim documents ("overlay writes for materialized children are provider territory — T2b's provider is the pi adapter, which doesn't author children in T2a"). Now a real provider exists and must author children. This milestone therefore includes a small registry change: **enable `PATCH /Workspace/<name>` upsert into the overlay**, validated through the same §8.3 write-time `rejectCheck` (fingerprint collision without lineage, duplicate durable id, parent cycle) before append — one bad child PATCH cannot poison the document set. This is the only registry change; everything else is the provider.

## 8. Test plan

- Step executors: `gitClone`/`worktree` against tmp git repos (no-op/ff/fail paths).
- Claim matching: route exact-match filter; released claims skipped; claims on other routes ignored.
- Child document construction: deterministic name/id, route copied with child path + precondition dropped, parent/fingerprint preserved.
- The loop end-to-end against a real registry (in-process store, real HTTP): POST claim → provider polls → child appears in overlay → child `ready:true` → consumer's poll resolves it.
- Unsupported-step and failure paths report `progress` and never write a child.

## 9. Milestone placement

New milestone **T2.5** between T2b (adapter) and T3 (k8s-exec): "localhost provider — claim fulfillment for local routes, embedded in twill-pi and standalone via `twill provider`." Unblocks live dogfooding of the full resolve→claim→materialize→attach loop.
