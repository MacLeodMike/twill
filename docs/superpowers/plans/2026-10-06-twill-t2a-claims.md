# Twill T2a (Claims machinery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the claims surface deferred from T1 — consumer claim create/release, provider claim read-path, the writable overlay, and registry-derived `claimedBy` — per core §8.3/§8.4/§9 and workspace §8.

**Architecture:** Claims are documents that live in a **writable overlay** (JSONL file beside the watched documents directory), merged over the watched source at read time. The overlay is the registry's only write path in v1alpha1. `claimedBy` on the status surface is derived from Claim documents by the registry, keyed on `claimedOn.fingerprint` (storage-backed kinds) / `claimedOn.durable_id` (others).

**Tech Stack:** TypeScript/Node (same stack as T1; vitest, node:http, yaml dep, tsx).

**Specs (authoritative — read before implementing):**
- `docs/superpowers/specs/2026-10-04-twill-fabric-core.md` (rev 10) — §8.3 (reject rules + orphan claims), §8.4 (claimedBy keying), §9 (claims as documents)
- `docs/superpowers/specs/2026-10-04-twill-workspace.md` (rev 10) — §8 (registry surface: overlay semantics, claim collision rule, endpoints)

## Global Constraints

- **Claim envelope** (core §9): `kind: Claim`; `spec` carries `owner`, `routes: []`, `claim: {...}`, `parent: {kind, name}`. Claim spec fields: `storageBacked: false`, `id`, `principal`, `route`, `parameters`, `claimedOn {fingerprint?, durable_id}`, `released: boolean`.
- **Claim rules** (core §9 verbatim): parent must reference an **existing** document (POST-time rejection otherwise); `spec.claim.route` records the resolved route verbatim; `claimedOn` carries fingerprint + durable_id (fingerprint absent for non-storage-backed kinds); claims never name not-yet-materialized children as parent.
- **claimedBy derivation** (core §8.4/§9): registry derives `claimedBy` from all **un-released** Claim documents whose `claimedOn` key matches — keyed on `fingerprint` for storage-backed kinds, `durable_id` for non-storage-backed. Element shape `{name, owner, principal, claimedOn}` = Claim's metadata.name, spec.owner, spec.claim.principal, spec.claim.claimedOn. Provider statusReport never carries claimedBy (already ignored with a warning in T1 — keep that).
- **Overlay semantics** (workspace §8): watched source is read-only; API-written documents live in a writable overlay JSONL file; union semantics (watched ∪ overlay), overlay wins on name collision (shadowing reported in `/health` `warnings`); overlay survives restarts; PATCH is upsert; **writes are validated before append** — a write whose merged result would violate §8.3 (fingerprint collision without lineage, duplicate durable id, parent cycle) is rejected with an error to the writer, never persisted.
- **Claim collision rule** (workspace §8): POST against an existing Claim name is rejected; PATCH on a Claim is restricted to setting `spec.claim.released: true` — a live claim cannot be silently overwritten.
- **Orphan claims** (core §8.3): a Claim whose parent reference does not resolve in the document set is marked inert and reported in `/health` `warnings` (`{orphan claim refs}`), never a set-level rejection.
- **Endpoints** (workspace §8, all under `/twill/v1alpha1`): `POST /Claim/<name>` (create claim), `PATCH /Claim/<name>` (release only), `GET /claims?parent=<kind>/<name>` (provider read-path, kind-qualified parent). The T1 501s for these paths are removed by this milestone. `PATCH /<kind>/<name>` for non-Claim kinds stays 501 (overlay writes for materialized children are provider territory — T2b's provider is the pi adapter, which doesn't author children in T2a).
- **Watch interaction**: overlay changes are not file-watched (the registry owns the overlay file; it appends and updates its in-memory state synchronously in the same request). The watched-source watcher behavior is unchanged.
- **claimedBy in resolve descriptors**: `statusFor` currently hardcodes `claimedBy: []`. After this milestone, `resolve` and `GET /<kind>/<name>`-adjacent status surfaces show derived claims. The T1 ledger note "statusFor claimedBy conventional not enforced" is discharged here.

## Review Focus

1. **A claim POST whose parent is a missing name** (consumer raced a document edit) → 4xx at POST time with a clear error, overlay untouched. → Task 2.
2. **A claim POST that would create a fingerprint/lineage violation in the merged set** (e.g. claim claims a parent that doesn't exist yet but names a colliding fingerprint — the write-time validation path) → rejected before append, never persisted. → Task 3.
3. **Two claims with the same `claimedOn` fingerprint seen through parent and child views** (the RWO cross-view visibility case §8.4 exists for) → both views' `claimedBy` include both claims. → Task 4.
4. **Registry restart with claims in the overlay** → claims survive, `claimedBy` derivation still works, watched source unchanged. → Task 3.
5. **A provider polling `GET /claims?parent=Workspace/x`** → only claims whose `spec.claim.route` matches the provider's filter shape (the route-match filter is the provider's job; the registry returns all claims against the parent and the provider filters client-side in v1alpha1 — the endpoint's contract is "all claims against this parent, un-released by default"). → Task 5.

---

### Task 1: Claim document validation + POST /Claim/<name> (create)

**Files:**
- Create: `src/registry/claims.ts`
- Modify: `src/registry/routes.ts` (replace the Claim 501s for POST)
- Modify: `src/registry/store.ts` (overlay write seam — see Interfaces)
- Test: `src/registry/claims.test.ts`

**Interfaces:**
- Consumes: `FabricDocument`, `documentKey`, `rejectCheck`, `RegistryStore` (all from T1, in `src/registry/`).
- Produces:
  - `validateClaimCreate(raw: unknown, store: RegistryStore): { ok: true; doc: FabricDocument } | { ok: false; status: number; error: string }` — validates the claim envelope against core §9 (kind Claim, `spec.claim` fields per Global Constraints, parent exists in the merged document set, name unique across watched ∪ overlay).
  - `store.appendOverlay(doc: FabricDocument): { ok: boolean; error?: string }` — validates the merged set (watched ∪ overlay ∪ new doc) through `rejectCheck` before appending; on violation returns the error and writes nothing. This is the overlay write seam Task 3 builds the file persistence behind; in Task 1 it may be in-memory only (the store keeps overlay documents in a Map), with file persistence landing in Task 3.

Behavior pins:
- Missing parent → `ok: false, status: 409, error` naming the missing parent (Review Focus #1).
- Existing Claim name (watched or overlay) → `ok: false, status: 409` (claim collision rule).
- `spec.claim.route` must be present and an object (verbatim route copy — T2a does not verify it against any resolved route; the binding is by exact-match convention for the provider).
- `spec.claim.claimedOn.durable_id` must equal the parent document's durable id; `claimedOn.fingerprint` must equal the parent's `spec.workspace.storage.fingerprint` when the parent is a Workspace (claims occupy the storage they claim against — §8.4). Mismatch → 4xx naming the mismatch.
- `released` defaults false when omitted.
- Route changes: `POST /twill/v1alpha1/Claim/<name>` → validate → `store.appendOverlay` → 201 with the claim document; 409/400 per above; other Claim methods keep the T1 501 (PATCH releases land in Task 2; GET /claims in Task 5).

- [ ] **Step 1: Write the failing tests**

In `claims.test.ts`, boot a fixture-backed store (temp copy of fixtures/documents) and construct raw claim bodies in-memory: (a) valid claim against `payments-repo` → ok; (b) missing parent → 409 naming the parent (Review Focus #1); (c) duplicate claim name → 409; (d) claimedOn.fingerprint mismatch → 4xx; (e) claimedOn.durable_id mismatch → 4xx; (f) non-object `spec.claim.route` → 400.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/registry/claims.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `claims.ts` + the store overlay seam + route wiring**

`validateClaimCreate` does shape + parent + claimedOn consistency checks. `store.appendOverlay` validates the merged set via `rejectCheck` (overlay documents + new doc included — in Task 1 the overlay is an in-memory Map the merge reads from). Wire POST /Claim/<name> in routes.ts; leave PATCH and GET /claims 501.

- [ ] **Step 4: Run to verify they pass + full gate**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all pass (prior 54 + new 6).

- [ ] **Step 5: Commit**

```bash
git add src/registry/claims.ts src/registry/claims.test.ts src/registry/routes.ts src/registry/store.ts
git commit -m "t2a: claim create — validation + overlay write seam"
```

---

### Task 2: PATCH /Claim/<name> (release only)

**Files:**
- Modify: `src/registry/claims.ts`
- Modify: `src/registry/routes.ts`
- Test: `src/registry/claims.test.ts`

**Interfaces:**
- Consumes: Task 1's `validateClaimCreate` shape + overlay seam.
- Produces: `validateClaimRelease(name: string, raw: unknown, store: RegistryStore): { ok: true; doc: FabricDocument } | { ok: false; status: number; error: string }` — the PATCH body must be a Claim document whose only change vs the stored claim is `spec.claim.released: true` (claim collision rule: a live claim cannot be silently overwritten; release is the only permitted mutation).

Behavior pins:
- PATCH on a missing claim → 404.
- PATCH changing any field other than `spec.claim.released` (diff the stored vs submitted claim after normalizing) → 409 naming the offending field(s).
- PATCH on an already-released claim with `released: true` → 200 idempotent (no-op release is fine).
- Release flows through the same appendOverlay seam (the overlay records the released version; derivation in Task 4 reads latest-per-name).

- [ ] **Step 1: Write the failing tests**

(a) release an existing claim → ok, released true; (b) PATCH missing claim → 404; (c) PATCH changing `spec.claim.parameters` → 409 naming the field; (d) re-release an already-released claim → 200.

- [ ] **Step 2-5: fail → implement → green → commit** (same gate as Task 1)

```bash
git commit -m "t2a: claim release — PATCH restricted to spec.claim.released"
```

---

### Task 3: Overlay file persistence (JSONL on disk, survives restart)

**Files:**
- Create: `src/registry/overlay.ts`
- Modify: `src/registry/store.ts`
- Test: `src/registry/overlay.test.ts`

**Interfaces:**
- Consumes: Task 1-2's in-memory overlay Map + `appendOverlay` seam.
- Produces:
  - `class OverlayStore` wrapping a JSONL file at `<documentsDir>/.twill-overlay.jsonl` (dot-prefixed so the document loader's `.yaml`-only walk never picks it up). `load(): FabricDocument[]` (latest-per-name reduction; a later line for the same name replaces the earlier), `append(doc: FabricDocument): void`.
  - `RegistryStore` takes an optional overlay path (production: beside the documents dir; tests: temp file). On `start()`, the overlay file is read and its documents merged over the watched set; on `appendOverlay`, the doc is appended to the file AND the in-memory map synchronously within the request.

Behavior pins:
- Restart durability (Review Focus #4): create claim → close store → `start()` a fresh store on the same dirs → claim present, appears in discovery, `claimedBy` derivable.
- Overlay wins on name collision; the shadowing is reported in `health().warnings` (workspace §8 — the warnings array is no longer always empty after this task).
- Corrupt overlay line (partial write) → skipped with a warning in `health().warnings`, rest of the overlay still loads (never crash the registry on overlay corruption).
- The JSONL line stores the full document envelope (the raw YAML-parsed object), one JSON object per line.

- [ ] **Step 1: Write the failing tests**

(a) claim → close → reopen → claim present (Review Focus #4); (b) overlay name-shadowing a watched document → overlay version served, warning in health; (c) corrupt line mid-file → skipped with warning, rest loads; (d) release survives restart (released claim stays released after reopen).

- [ ] **Step 2-5: fail → implement → green → commit**

```bash
git commit -m "t2a: overlay JSONL persistence — restart durability, shadowing warnings"
```

---

### Task 4: claimedBy derivation (core §8.4 keying)

**Files:**
- Modify: `src/registry/status.ts`
- Modify: `src/registry/store.ts` (expose claims index to statusFor)
- Test: `src/registry/status.test.ts`

**Interfaces:**
- Consumes: overlay claims (Task 3), `StatusCache`/`StatusSurface` (T1).
- Produces:
  - `deriveClaimedBy(doc: FabricDocument, claims: FabricDocument[]): ClaimedRef[]` — all un-released Claims whose `claimedOn` key matches the document: `fingerprint` equality for storage-backed kinds, `durable_id` equality otherwise (§8.4). Element shape `{name, owner, principal, claimedOn}` per Global Constraints.
  - `statusFor(doc, cache, claims)` gains the claims parameter (third arg); `claimedBy` comes from `deriveClaimedBy`, never from the cache. Callers updated (resolver.ts's statusFor call site, routes.ts discovery/descriptor paths).

Behavior pins:
- **Cross-view visibility** (Review Focus #3): claims against parent `payments-repo` and child `payments-repo-feat-x` share fingerprint `vol-2c4f1a` → both documents' `claimedBy` list both claims. This is the RWO-advisory case §8.4 exists for; the test must pin it.
- Released claims are excluded the moment `released: true` lands in the overlay.
- Non-storage-backed kinds key on `durable_id` (construct an in-memory non-Workspace claim case — e.g. a Claim against a Card document — to pin the keying).
- Orphan claims (parent deleted) still derive normally (their `claimedOn` doesn't depend on the parent existing) — they're inert + health-warning per Task 5, but claims against the *fingerprint* remain visible.

- [ ] **Step 1: Write the failing tests**

(a) single claim → parent's claimedBy shows it; (b) parent+child cross-view → both show both claims (Review Focus #3); (c) released claim excluded; (d) non-storage-backed keying; (e) resolve descriptor's status.claimedBy matches (integration through resolver).

- [ ] **Step 2-5: fail → implement → green → commit**

```bash
git commit -m "t2a: claimedBy derivation — §8.4 fingerprint keying, cross-view visibility"
```

---

### Task 5: GET /claims?parent=<kind>/<name> (provider read-path) + orphan-claim health warnings

**Files:**
- Modify: `src/registry/routes.ts`
- Modify: `src/registry/store.ts` (orphan detection feeds health warnings)
- Test: `src/registry/server.test.ts` (extend the existing HTTP suite)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `GET /twill/v1alpha1/claims?parent=<kind>/<name>` → 200 with an array of claim documents (un-released only by default; `?includeReleased=true` opts in to released ones). The kind-qualified parent param is required — `GET /claims` without `parent` → 400 naming the missing parameter. Provider-side route filtering (`spec.claim.route` exact match) is the caller's job in v1alpha1 (Review Focus #5 — the endpoint's contract is all-claims-against-parent).

Behavior pins:
- The T1 501 for `GET /claims` is removed; the 501 for `POST /claims` (plural) stays removed (it never was a real endpoint — POST is `/Claim/<name>`; adjust the T1 route table so plural-POST falls through to 404, and note it).
- Orphan claims: after a parent is removed from the watched set (file deleted → reload), claims naming it are inert, still served by `GET /claims?parent=...` (the parent's *name* is still a valid query — orphan claims are listed, marked inert in their serialized form), and reported in `GET /health` `warnings` as `{type: "orphan-claim", claim: <name>, parent: <kind>/<name>}`.
- Claims query against a parent that never existed → 200 with `[]` (not an error — providers poll for parents that may not be registered yet).

- [ ] **Step 1: Write the failing tests**

(a) claims against payments-repo → 200 with the claim; (b) no parent param → 400; (c) parent never existed → 200 `[]` (Review Focus #5); (d) parent file deleted → reload → claim still listed (inert) + health warnings carry the orphan entry; (e) includeReleased flag.

- [ ] **Step 2-5: fail → implement → green → commit**

```bash
git commit -m "t2a: provider claims read-path + orphan-claim health warnings"
```

---

### Task 6: CLI surface for claims + docs refresh

**Files:**
- Modify: `src/cli/twill.ts`
- Modify: `README.md`
- Test: `src/cli/twill.test.ts` (extend)

**Interfaces:**
- Consumes: the full T2a HTTP surface.

Behavior pins:
- `twill claim create <parentKind> <parentName> --principal <p> --route '<json>' [--param k=v]... [--name <claimName>]` — creates a claim (name defaults to `claim-<parent>-<principal-sanitized>-<timestamp>`). Prints the created claim JSON.
- `twill claim release <name>` — PATCH release.
- `twill claims <parentKind> <parentName>` — table of un-released claims against the parent.
- README: replace the claims-501 note with the real commands; one paragraph on the overlay (`.twill-overlay.jsonl` beside the documents dir) and restart durability.
- Update the exit-code contract docs: claim create 0/1 (4xx → 1 with the error body printed).

- [ ] **Step 1: Write the failing tests**

Subprocess tests per the existing harness: (a) `claim create` against payments-repo → 0, JSON parseable; (b) `claims Workspace payments-repo` lists it; (c) `claim release` → 0; (d) released claim absent from `claims` default output.

- [ ] **Step 2-5: fail → implement → green → commit**

```bash
git commit -m "t2a: twill CLI claims commands + README"
```

---

## Self-review notes (checked before saving)

- **Spec coverage:** claims create/read/release (workspace §8 endpoints) ✓ T1/T2/T5; overlay semantics incl. shadowing warnings + write-time validation ✓ T3 (+ seam in T1); claimedBy derivation §8.4 ✓ T4; orphan-claim warnings §8.3 ✓ T5; claim collision rule ✓ T1/T2; provider read-path ✓ T5. T1's 501s removed for the claim paths; non-Claim PATCH stays 501 (provider-authored children land with T2b's provider side).
- **Type consistency:** `validateClaimCreate`/`validateClaimRelease` return the same union shape; `deriveClaimedBy` produces the `ClaimedRef` type T1 already declared in status.ts; `appendOverlay` seam introduced in T1-of-this-plan and consumed by T2/T3.
- **Proportion:** 6 tasks; the heaviest (T3 overlay persistence) is still a single-file module with one seam into the store.
- **T1 ledger discharge:** "statusFor claimedBy conventional not enforced" (T4 minor) is discharged in Task 4 (claimedBy derives from claims, cache can't inject). "health() hardcodes warnings" (T5 minor) is discharged in Tasks 3/5 (warnings become real).
