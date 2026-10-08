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
