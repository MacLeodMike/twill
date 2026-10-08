# twill

twill is a minimal, typed agent-fabric registry. It watches a directory of YAML
documents (Workspaces in v1alpha1), validates them against lineage and fingerprint
rules, and exposes a tiny HTTP API plus a CLI for resolve, discovery, health,
status reporting, and claims. It is the T2a milestone of the broader twill fabric
described in the workspace spec (docs/superpowers/specs/2026-10-04-twill-workspace.md)
and fabric-core spec (docs/superpowers/specs/2026-10-04-twill-fabric-core.md).

## Run

```bash
npm install
npm start
```

The registry listens on `PORT` (default `8080`) and reads documents from
`TWILL_DOCUMENTS_DIR` (default `fixtures/documents`). The `npm start` script
uses tsx; the same entrypoint is used in the Dockerfile.

With the server running, the CLI can resolve a route:

```bash
npm run cli -- resolve Workspace workstation-repos --principal user:example
```

Other commands: `npm run cli -- list`, `npm run cli -- get <kind> <name>`,
`npm run cli -- health`.

## Claims (T2a)

Claims are first-class children (core §9): a consumer adapter creates a Claim
document against a registered parent; providers poll the parent-scoped read
path and materialize from it.

```bash
# create — the CLI fetches the parent to compute claimedOn, then prints the
# created claim envelope (name defaults to claim-<parent>-<principal>-<epoch>)
npm run cli -- claim create Workspace payments-repo \
  --principal user:you --route '{"type":"local","path":"~/repos/payments-repo"}' \
  --param branch=feat-x

# list the un-released claims against a parent (name, principal, durable_id)
npm run cli -- claims Workspace payments-repo

# release — the only permitted mutation (workspace §8's claim collision rule)
npm run cli -- claim release Workspace payments-repo claim-payments-repo-user-you-<epoch>
```

The matching HTTP surface: `POST /twill/v1alpha1/Claim/<name>` (201; 400
malformed, 409 missing parent / name collision, 422 claimedOn inconsistent
with the parent), `PATCH /twill/v1alpha1/Claim/<name>` (release only — the
PATCH body is the full envelope with only `spec.claim.released` flipped), and
`GET /twill/v1alpha1/claims?parent=<kind>/<name>` (200 array; released claims
need `includeReleased=true`). `GET /Claim/<name>` stays 501 — there is no
single-claim read endpoint in v1alpha1.

### The writable overlay

Claim writes are persisted to `.twill-overlay.jsonl` — one JSON envelope per
line, latest-per-name on read — in the documents directory, beside the watched
YAML. Claims survive registry restarts that way; the file is read once at
startup and only ever appended to while running. Deployment consequence: the
registry needs **write access to the documents directory** (the compose file
mounts it `:rw`, not `:ro`).

## Exit codes

`resolve`: Attached 0, NoMatch 2, Unreachable 3. Everything else (`list`,
`get`, `health`, `claim create`, `claim release`, `claims`): 0 on success, 1
on HTTP error (4xx included — the registry's error body prints to stderr),
transport failure, or usage error.

## Docker Compose

The minimal deployment is a single registry container with the documents bind
mount (read-write, so the registry can persist the claims overlay):

```bash
docker compose -f deploy/compose.yml up --build -d
curl -s localhost:8080/twill/v1alpha1/health
```

The compose file also carries a commented-out `twill-static-provider` sidecar
block (tier-2 in the workspace spec §9.1) that can be enabled to push periodic
status reports.

## Scope notes

Workspaces are the only registered kind-runner; other kinds load inert.
`PATCH /twill/v1alpha1/<kind>/<name>` upserts provider-authored documents
(child Workspaces included) into the writable overlay: the body is the full
document envelope as JSON, the URL kind/name must match the envelope, and a
write whose merged result would violate §8.3 (fingerprint collision without
lineage, duplicate durable id, parent cycle) is rejected 409 and never
persisted. Claim PATCH stays release-only.

## The provider (the fabric's third party)

The registry is the menu; the consumer attaches. The **provider** is the third
party that *materializes* — it owns workspaces, runs their preconditions, and
reports state. Without one, a claim against a cold workspace is never answered.
The localhost provider here is the reference implementation: it polls the
registry for claims, materializes them with local `git`, and reports back — all
over HTTP, the same bytes any third-party provider exchanges.

### `twill provider --config <file>`

Runs a provider against a config file (YAML, or JSON as its subset):

```yaml
registry: http://localhost:8080      # the /twill/v1alpha1 prefix is added when absent
pollIntervalMs: 5000                  # optional, default 5000
parents: [workstation-repos]          # the parent workspaces this provider polls
routes:                               # the verbatim route objects this provider owns
  - match: { agentLocation: workstation }
    type: local
    path: ~/repos/workstation-repos
    precondition:
      steps:
        - { type: gitClone, url: git@example:me/repo.git, ref: main }
```

The provider owns exactly the routes it's configured with. A claim carries a
verbatim copy of the route it resolved against (`spec.claim.route`); the
provider fulfills a claim only when that route **deep-equals** one of its own
`routes` — so two providers backing one fingerprint never both materialize, and
a claim for a route the provider doesn't own is ignored (no materialization, no
statusReport).

For each owned claim it polls on a parent, the loop:

1. reports the parent `ready: false` (`provisioning …`),
2. runs the route's `precondition.steps[]`, substituting the claim's
   `parameters` (`{{claim.parameters.branch}}`, `{{claim.parameters.worktreeName}}`),
3. on success, PATCHes the deterministic child document into the overlay
   (`<parent>-<worktreeName>`; child `storage.id` is the parent's id suffixed
   with the worktree name, so a duplicate claim converges rather than
   duplicating) and reports the child `ready: true`,
4. restores the parent's own state; on failure reports `ready: false` with the
   reason and writes no child.

A claim with no `worktreeName` is a **cold-root** claim: the parent itself is
materialized and reported ready, with no child document.

v1 implements the two local precondition steps, `gitClone` and `worktree`;
`pvcBind` / `remoteMkdir` / `mountCheck` (cluster shapes) are rejected — the
claim fails with a progress note naming the unsupported step rather than
half-materializing. The provider is HTTP-only to the registry (it never touches
the store directly) and single-process (no cross-process locking); claims on
one parent are fulfilled serially, distinct parents concurrently.

### Embedding (the homelab one-install story)

`startProvider` is importable, so a consumer runtime can host the loop
in-process instead of running a separate daemon — `twill-pi` embeds it so the
homelab user who installs the pi extension gets a registry *and* a provider
from one install:

```ts
import { startProvider } from "twill/src/provider/loop.js";

const handle = startProvider({
  registry: "http://localhost:8080",
  parents: ["workstation-repos"],
  routes: [/* the verbatim route objects this provider owns */],
  pollIntervalMs: 5000,        // optional
  onEvent: (line) => log(line) // optional lifecycle observer (one line per event)
});
// …later, on shutdown:
handle.stop();
```

The `ProviderConfig` field names are the wire shape an embedder constructs;
`onEvent` receives one self-describing, timestamped line per poll-observed
event (fulfilled / failed / ignored / skipped).

Known gaps, honestly: the provider stops on SIGINT only (no SIGTERM handler —
the cluster milestone's concern), there's no provider discovery yet (the
binding is configured, per the spec), and a long-lived un-released claim's
skip/ignore log line repeats every poll (steady-state noise, to be demoted).
