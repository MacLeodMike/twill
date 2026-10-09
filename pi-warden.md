# No hardcoded secrets

Source code must not contain passwords, API keys, tokens, or connection URLs with credentials.
Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what

A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment
that restates what the next line plainly does is a violation.

# Errors are not swallowed

A `catch` block must handle the error, report it, or re-raise it. An empty catch block, or
one whose body is only a comment, is a violation.

# No partial implementations

Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead
of stubbing it.

# Do not run destructive commands that erase uncommitted work

`git reset --hard`, `git checkout -- .`, `git clean -fd`, and similar commands that discard
untracked or uncommitted changes are forbidden. These destroy work that has no backup. If a
clean tree is needed, create a worktree instead or ask the user.

# No explicit any

paths: **/*.ts, **/*.tsx

Source code must not use an explicit `any` type. Use `unknown`, a structural type, or a
generic. (`any` disables typechecking at that point; `unknown` keeps it honest.)

# Exported functions declare their return type

paths: src/**/*.ts

An exported function must declare its return type explicitly. Inference is fine for locals;
the return type is part of an export's contract and must be written down.

# The provider talks to the registry over HTTP only

source: AGENTS.md:45
paths: src/provider/**/*.ts

Production code in `src/provider/` must not import the registry's store, overlay, server, or
loader (`../registry/store`, `/overlay`, `/server`, `/loader`). The provider is a separate
party; it exchanges the same bytes a third-party provider would, over HTTP. Wire-type imports
from `../registry/document` are fine. Test files MAY import the store/server to boot a real
in-process registry (that's the harness), so this rule applies to non-test source only.

# Child workspace names and ids are deterministic and stable

source: AGENTS.md:49
source: AGENTS.md:53
paths: src/provider/**/*.ts

A materialized child is named `<parent>-<worktreeName>` and its `storage.id` is
`<parent-storage.id>-<worktreeName>` — a pure function, so a duplicate claim converges rather
than duplicating. The single derivation is `childNameFor` in `src/provider/child.ts`; child
names/ids must not be constructed elsewhere. And a workspace's `storage.id` must never change
on rename or be recomputed from a mutable display name (the env-id invariant: two environments
resolving to the same physical storage share an id, or they corrupt each other's edits).

# Registry writes go to the validated overlay, never the watched source

source: AGENTS.md:57
paths: src/registry/**/*.ts

The watched documents source is read-only. API-written documents (claims, materialized
children) are appended to the writable overlay (`.twill-overlay.jsonl`), and a write whose
merged result would violate the lineage rules is rejected before append — never persisted.
Code must not write the watched source directly, and must not append to the overlay without
the merged-set validation.

# Provider lifecycle events are deduped per claim

source: AGENTS.md:67
paths: src/provider/loop.ts

A claim in a steady state (already-fulfilled skip, persistent failure, route-not-owned ignore)
must not re-emit the identical line every poll. The per-claim consecutive dedup (`emitClaim`
keyed by claim name) suppresses it; a changed event (a retry, a different failure) still
emits. Do not "simplify" the dedup back to a bare `emit`.
