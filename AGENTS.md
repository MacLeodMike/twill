# AGENTS.md — working in the twill repo

Operational guidance for a coding agent. The **why** is `CONTEXT.md`; the
**what** (authoritative design contracts) is `docs/superpowers/specs/`. This
file is the **how**.

## What this is

twill is the agent ↔ workspace fabric: a typed registry + resolve/route
protocol for execution environments. Three parties, protocol-level:

- **Registry** (`src/registry/`) — the directory. Serves the document set,
  selects routes, holds the claims overlay. Never materializes.
- **Provider** (`src/provider/`) — materializes claimed workspaces (the
  localhost provider: `gitClone`/`worktree`). Talks to the registry over HTTP
  only.
- **CLI** (`src/cli/twill.ts`) — the `twill` command, the registry's first
  consumer. Also hosts `twill provider` (the standalone provider process).

Consumers (pi adapters) live in sibling repos: `~/repos/twill-pi` (substrate),
`~/repos/twill-pi-workspace` (workspace kind tools + write guard).

## Commands

```bash
npm install          # deps (tsx, typescript, vitest, yaml)
npm test             # vitest run — the gate; must be green before commit
npx tsc --noEmit     # typecheck — must be clean
npm start            # registry: tsx src/registry/server.ts (PORT, TWILL_DOCUMENTS_DIR)
npm run dev          # registry with tsx watch
npm run cli -- <cmd> # the twill CLI (resolve/list/get/health/claim/provider)
```

A full green run is `npm test` AND `npx tsc --noEmit` both clean. The CLI and
provider tests spawn real processes and tmp git repos — they're slow; that's
normal, not a hang.

## Conventions that carry weight

- **Specs are authoritative.** Design contracts live in
  `docs/superpowers/specs/` (fabric core, workspace, localhost provider). Code
  follows them; when they disagree, the spec wins or the spec is amended first.
- **TDD.** Failing test first, then implementation, then green. Every behavior
  has a pin.
- **The party boundary is kept honest.** The provider talks to the registry
  over HTTP (the same bytes a third-party provider would exchange) — it never
  imports the registry store. Wire-type imports from `registry/` are fine;
  store/overlay/server imports in `src/provider/` production code are not.
- **The env-id invariant (spec §5).** Two environments resolving to the same
  physical storage MUST share a `storage.id`; renaming a workspace must not
  change it. This is the one non-negotiable invariant — it prevents corrupting
  each other's edits.
- **Deterministic child naming.** A materialized child is `<parent>-<worktreeName>`,
  `storage.id` = `<parent-storage.id>-<worktreeName>` — a pure function, so a
  duplicate claim converges rather than duplicating (`src/provider/child.ts`,
  `childNameFor` is the single derivation).
- **The registry's watched source is read-only; writes go to the overlay**
  (`.twill-overlay.jsonl`), validated against the merged set before append.

## Known false positives / environment quirks

- **pi-lens anti-slop rule** flags the `JSON.parse(JSON.stringify(x))`
  deep-clone in `src/cli/twill.ts` (claim release) as "throws without
  try/catch". It can't throw (the input is already valid JSON). Ignore it.
- **pi-warden** holds plain file writes when TypeSafe is unreachable +
  failOpen=false; the identical retry succeeds a moment later. Transient.
- **Steady-state provider logs** are deduped per claim (`emitClaim`); a changed
  event still emits. Don't "simplify" the dedup back to bare `emit`.

## Testing against a live registry

`npm start` (or `PORT=8091 TWILL_DOCUMENTS_DIR=<dir> npx tsx src/registry/server.ts`)
runs a local registry. The dogfood environment lives in `~/.twill/` (documents
in `~/.twill/documents`, scratch origin in `~/.twill/dogfood`). Port 8080 is
taken by another service on the workstation — use another port.
