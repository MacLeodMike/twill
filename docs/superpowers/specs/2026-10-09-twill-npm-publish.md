# Publish the twill packages to npm — design

**Date:** 2026-10-09
**Status:** draft — proposed
**Decisions locked (user):** three separately-published packages; the core is `@bitwise-operations/twill` (scoped — `twill` is squatted on npm).

## 0. One sentence

Turn the three local `file:`-linked repos into three published npm packages — `@bitwise-operations/twill` (the fabric: registry + provider + CLI), `@bitwise-operations/twill-pi` (the pi substrate, which embeds the provider), `@bitwise-operations/twill-pi-workspace` (the workspace adapter) — so a pi user installs them by name and the dependency chain resolves through npm instead of local paths.

## 1. The chain and why it's ordered

```
@bitwise-operations/twill            (core; no pi manifest; exports ./provider, ./registry, CLI bin)
        ↑ file: → becomes a published dep
@bitwise-operations/twill-pi         (pi substrate; imports twill/provider + twill/registry; pi.extensions: [./index.ts])
        ↑ file: → becomes a published dep
@bitwise-operations/twill-pi-workspace (pi adapter; imports twill-pi/*; pi.extensions: [./index.ts])
```

Publishing must go bottom-up: twill first, then twill-pi (needs twill's published version), then twill-pi-workspace (needs twill-pi's).

## 2. The dependency mechanism (the load-bearing design point)

pi's rule (packages.md): "Other pi packages used as dependencies must be included in the published tarball and referenced through their node_modules resource paths." Our chain is exactly that — twill-pi is a pi package that depends on twill (and workspace on twill-pi).

Two ways to satisfy it:

- **(a) Real npm dependency + pi installs it.** List the dependency in `dependencies` (e.g. twill-pi → `"@bitwise-operations/twill": "^0.1.0"`). pi's `installNpm` runs `npm install`, so the dep lands in the package's node_modules and imports resolve via normal resolution. This is the standard path and what the docs' "Pi installs package dependencies when it installs an npm source" describes. **Chosen.**
- (b) Bundled-in-tarball. Vendoring the dep's source into the publisher's tarball. More moving parts, duplicates the code, and unnecessary when (a) works. Rejected.

The "separate module roots" property is preserved either way (pi loads each top-level installed package at its own root); the dependency is shared within a package's own tree, which is fine — the session-state isolation we rely on is across the two *pi packages* (substrate vs adapter), not between a package and its library dep.

## 3. Per-package changes

### `@bitwise-operations/twill` (core)

- `name` → `@bitwise-operations/twill`; drop `private: true`; add `version: 0.1.0`, `license`, `repository`, `description`, `keywords`.
- `exports`: expose `./provider` (existing), `./registry` (store + server + wire types the embedder/integration tests need), and `./document` (the wire types `Route`, etc.). Keep it minimal.
- `bin`: `twill` → a small `cli.js` shim that runs `src/cli/twill.ts` via tsx (the published package ships TS source; the bin shim invokes it with tsx). `tsx` is a runtime dependency so the bin is self-contained.
- `files`: `["src", "README.md", "LICENSE", "docs/superpowers/specs"]` — ship the source + the specs (the specs ARE the contract; consumers and the provider spec reference them). Exclude `node_modules`, tests stay in src (they're `.test.ts`; fine to ship or exclude — ship, they're small and prove the contract).
- Add a `LICENSE` (MIT, matching the pi packages' stated license).

### `@bitwise-operations/twill-pi` (substrate)

- `name` → `@bitwise-operations/twill-pi`; `version: 0.1.0`; add `license`, `repository`, `keywords`.
- `dependencies`: `"@bitwise-operations/twill": "^0.1.0"` (replacing the `file:` path).
- Imports `twill/provider` → `@bitwise-operations/twill/provider` (and the integration test's deep `../node_modules/twill/src/registry/*` imports become `@bitwise-operations/twill/registry` — the deep path was a dev-shape workaround for twill having no `./registry` export).
- `typebox` stays `peerDependencies: "*"`.
- `files`/`pi` manifest already correct.

### `@bitwise-operations/twill-pi-workspace` (adapter)

- `name` → `@bitwise-operations/twill-pi-workspace`; `version: 0.1.0`; `license`, `repository`, `keywords`.
- `dependencies`: `"@bitwise-operations/twill-pi": "^0.1.0"` (replacing `file:`).
- Imports `twill-pi/config` etc. → `@bitwise-operations/twill-pi/config` etc.

## 4. Versioning + the publish command

- All three start at `0.1.0`. Independent versioning thereafter (no lockstep); dep ranges are `^` so a patch bump in twill flows to twill-pi without a twill-pi republish.
- Publish is a manual `npm publish --access public` per package, in dependency order, after each package's tests pass with its `file:` dep swapped for the published one. (npm auth is the user's: `npm login` / a granular token.)
- A `scripts/publish.sh` (or just a README section) documenting the order + the exact commands, so it's repeatable.

## 5. Testing the published shape before pushing

For each package, in order:
1. Swap the `file:` dep for the published version, `npm install`, run `npm test` + `npx tsc --noEmit` — proves the published dep satisfies the imports.
2. `npm pack` and inspect the tarball (`npm pack --dry-run` / extract) to confirm `files` includes everything needed and excludes `node_modules`/`docs/superpowers/plans` (plans are dev artifacts; specs ship).
3. Install into a scratch pi config dir and load — proves pi resolves the npm package + its dep tree.

## 6. What this does NOT do

- No CI publish automation (manual `npm publish`; a trusted-publishing / CI workflow is a later hardening step).
No change to the dev workflow in the repos: the published `package.json` carries the npm dep; during active local development a developer overlays the local checkout with `npm install ../twill` (which replaces the published dep with the local one for that working tree).
- No version-locked monorepo tooling (nx/changesets) — three packages is below that threshold.

## 7. Risks

- **npm auth / 2FA** on the user's account — the publish step needs `npm login` or a token; that's the user's to provide.
- **`twill` CLI bin via tsx**: shipping TS source and running through tsx works but is unusual for a bin; a `dist/` build is more standard. v1 ships TS+tsx (matching how the repo runs it today); if the tsx bin proves fragile for consumers, the follow-up is a `tsc` build emitting `dist/` with the bin pointing at compiled JS.
- **Scoped-package install**: pi's npm install of a scoped name (`@bitwise-operations/twill-pi`) is verified at step 5 before publish.
