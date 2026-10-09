#!/usr/bin/env bash
# Publish the twill packages to npm under @bitwise-operations, in dependency
# order: twill (core) -> twill-pi (substrate) -> twill-pi-workspace (adapter).
# Each package's publish is gated on its own test + typecheck gate.
#
# Requires MIKEMACLEOD_NPM_TOKEN in the environment (the per-repo .npmrc reads
# it for the registry auth). Run from anywhere; the repos are pinned below.
set -euo pipefail

: "${MIKEMACLEOD_NPM_TOKEN:?MIKEMACLEOD_NPM_TOKEN must be set (the npm granular access token)}"

TWILL="${TWILL_REPO:-$HOME/repos/twill}"
TWILL_PI="${TWILL_PI_REPO:-$HOME/repos/twill-pi}"
TWILL_PI_WORKSPACE="${TWILL_PI_WORKSPACE_REPO:-$HOME/repos/twill-pi-workspace}"

publish() {
  local repo="$1" name="$2"
  echo "==> $name ($repo)"
  cd "$repo"
  npm test
  npx tsc --noEmit
  npm publish --access public
  echo "    published $name"
}

publish "$TWILL" "@bitwise-operations/twill"
publish "$TWILL_PI" "@bitwise-operations/twill-pi"
publish "$TWILL_PI_WORKSPACE" "@bitwise-operations/twill-pi-workspace"

echo "==> all three published."
