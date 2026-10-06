# twill

twill is a minimal, typed agent-fabric registry. It watches a directory of YAML
documents (Workspaces in T1), validates them against lineage and fingerprint
rules, and exposes a tiny HTTP API plus a CLI for resolve, discovery, health,
and status reporting. It is the T1 milestone of the broader twill fabric
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

## Docker Compose

The minimal deployment is a single registry container with a read-only
documents bind mount:

```bash
docker compose -f deploy/compose.yml up --build -d
curl -s localhost:8080/twill/v1alpha1/health
```

The compose file also carries a commented-out `twill-static-provider` sidecar
block (tier-2 in the workspace spec §9.1) that can be enabled to push periodic
status reports.

## T1 scope notes

Claims create/read and the writable overlay are not implemented in T1 and
return HTTP 501. Workspaces are the only registered kind-runner; other kinds
load inert.
