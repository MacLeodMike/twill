# Card / skuld — schema holding note

**Status:** Schema-reserved, implementation deferred. This is NOT a spec to
implement from — it pins the load-bearing design decisions from the original
fabric spec (2026-10-02) so that nothing in the fabric layer needs a breaking
change when Card is built. Card's full design gets its own spec when
prioritized; see "Revisit inputs" below.

**Why this is a holding note:** During spec review (2026-10-04) Card was
judged the least-defensible part of the fabric — it invites direct comparison
to Beads (steveyegge/beads) and Claude Code Agent Teams, which are richer
work-tracking systems, whereas the fabric layer has no real incumbent. Card
implementation is parked until after `twill` + `twill-workspace` deployment.
The fabric must not be held hostage to its weakest kind.

---

## 1. What Card is pinned to look like (schema, not behavior)

The fields below conform to the fabric-core envelope (`spec.<kindname>`
for kind data, `routes` and `owner` at top level). Card is **not
storage-backed** in v1alpha1 (its persistent store is the card service's own,
not bytes an agent serializes against), so its durable id is
`spec.card.id`. The pinned `spec.card` fields are what adapters may safely
assume exist when they encounter a Card document. Anything not listed here
is undefined and may change.

```yaml
apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Card
metadata: { name: <string>, labels: {} }
spec:
  owner: <subject>
  routes: []          # likely unused for cards in v1alpha1; pinned for envelope
  card:
    storageBacked: false               # per fabric-core §4.3: Card is NOT storage-backed
    id: cd_...        # durable id (Card's identity; no write serialization invariant)
    title: <string>
    state: idea | specced | ready | claimed | executing | review | done | blocked
    workspace_ref: <workspace name, optional>
    repo_refs: [<repo identifiers>]     # multi-repo by design
    spec_ref: <link to a spec/PR/issue>
    claimed_by: <session/run id | "">
    claim_token: <random | "">
    labels: [<strings>]
  parent: null        # or { kind: Card, name: <parent card> } (core §4.2; supersedes the drafts' card.parent_card)
status: {}            # reserved, controller-owned in v2
```

(`parent_card` from the revision-1 drafts is moved to the protocol-level
`parent` field defined in fabric-core §4.2 — delete-on-resume the future
Card spec should use `spec.parent`, not a kind-local duplicate. This note
updates the pinned schema accordingly so adapters reading Cards see the
protocol-level field.)

Pinned because adapters and the discovery endpoint (`GET /twill/v1alpha1`
listing kinds) round-trip Card *shape* in v1 even though no Card *service*
runs in v1. Documents conforming to this schema can be added to registry YAML
at any time without breaking anything.

## 2. Design decisions that survive from the original spec

These are the hard-won constraints, kept so the future Card spec doesn't
re-litigate them:

- **Dumb state machine.** `idea → specced → ready → claimed → executing →
  review → done | blocked`. No auto-transitions; validation only. The
  deliberate split of `claimed` (atomic reservation) from `executing`
  (claimer's agent actually running) is kept — it exists to answer "did it
  pick it up?" from across the network.
- **Weak unique-claimer.** `claim` returns a random `claim_token`; mutation
  requires it. Not a lease — the AWCP lease model is a *revisit input*, not
  baked in.
- **Cross-repo is the reason to exist.** `repo_refs` (plural) + `spec_ref` is
  the differentiator vs per-repo issue trackers. Single-repo work belongs in
  the repo's native tracker.
- **Cards as future dispatch handles.** A claimed Card + an AgentProfile
  workspace + a runner model is the spawn point for AgentProfile dispatch.
  Card state names were chosen so this composition is low-diff later.
- **`owner` non-optional**, non-storage-backed durable id (`spec.card.id`),
  kind data under `spec.card` — conformant to the fabric-core envelope.

## 3. What is deliberately *not* pinned

- REST API shape (the original spec sketched a `/cards` API in §4.2; that's a
  starting sketch, not a decision)
- Persistence (SQLite was sketched; not decided)
- Any claim *lease*/TTL machinery — see revisit inputs
- Any auto-transition, escalation, or workflow automation

## 4. Revisit inputs (recorded for the future Card spec session)

These came out of the 2026-10-04 research/AWCP review and the adjacent-tools
survey; the Card spec session must consciously respond to each:

1. **AWCP lease model** (arXiv 2602.20493): delegation carries TTL + access
   mode; the executor may *narrow* terms instead of accept/reject. The Card
   `claim_token` is weaker; consider whether claimed cards carry a TTL and a
   narrowing semantic.
2. **Beads** (github.com/gastownhall/beads) is the direct incumbent: Dolt +
   git, dependency graph, epics/molecules/formulas, `bd ready`/`--claim`,
   hash-based IDs chosen for the same multi-agent collision reason twill's
   storage IDs exist. Card must either out-do Beads, or justify *why* cards
   aren't just Beads. Do not ignore this question.
3. **Claude Code Agent Teams**: vendor-native shared task list w/ claims and
   git-worktree conflict avoidance. Absorbs part of the "shared claim board"
   use case; the Card answer is agent-agnostic + cross-repo.
4. **AWCP dual state machine** (delegator 9-state, executor minimal) — informs
   how a claimed→executing→done handoff to a remote executor could be
   structured without twill keeping shared state.

## 5. Interaction with the fabric layer today

- `GET /twill/v1alpha1` (discovery) **must** list Card documents in
  `v1alpha1` with `resolvable: false` even though no Card service runs —
  registry documents of kind Card are valid, just inert. The abstract
  discovery list shape is `{ kind, name, durable_id, resolvable }` (fabric-core
  §7.3); concrete transport is the registry service's business.
- Card documents in registry YAML are **inert** in v1: no resolve behavior,
  no precondition behavior, no status writes.
- The Card kind does not exempt any agent adapter from implementing Workspace
  first; Cards are not part of serialize-by-`storage.id` correctness (only
  Workspaces route to backing storage).
