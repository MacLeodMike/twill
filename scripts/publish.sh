#!/usr/bin/env bash
# Publish the twill packages to npm under @bitwise-operations, in dependency
# order: twill (core) -> twill-pi (substrate) -> twill-pi-workspace (adapter).
#
# Each package's publish is gated on its own test + typecheck. For the two
# packages whose dependency is a local file: path during development, the
# script swaps the file: dep for the published semver range, runs the gate,
# publishes, then restores the file: path — the working tree stays dev-shaped.
#
# Requires MIKEMACLEOD_NPM_TOKEN in the environment (each repo's .npmrc reads
# it for registry auth).
set -euo pipefail

: "${MIKEMACLEOD_NPM_TOKEN:?MIKEMACLEOD_NPM_TOKEN must be set (the npm granular access token)}"

TWILL="${TWILL_REPO:-$HOME/repos/twill}"
TWILL_PI="${TWILL_PI_REPO:-$HOME/repos/twill-pi}"
TWILL_PI_WORKSPACE="${TWILL_PI_WORKSPACE_REPO:-$HOME/repos/twill-pi-workspace}"

# publish <repo> <package-name> [dep-name dep-file-path dep-version]
# When the three dep args are given, the named dependency's file: value is
# replaced with the semver range for the gate+publish, then restored after.
publish() {
  local repo="$1" name="$2" dep_name="${3:-}" dep_file="${4:-}" dep_ver="${5:-}"
  echo "==> $name ($repo)"
  cd "$repo"

  local restored=""
  if [[ -n "$dep_name" ]]; then
    DEP_NAME="$dep_name" DEP_FILE="$dep_file" DEP_VER="$dep_ver" node -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync("package.json", "utf8"));
      d.dependencies[process.env.DEP_NAME] = process.env.DEP_VER;
      fs.writeFileSync("package.json", JSON.stringify(d, null, 2) + "\n");
    '
    restored="$dep_file"
    npm install --no-audit --no-fund
  fi

  npm test
  npx tsc --noEmit
  npm publish --access public
  echo "    published $name"

  if [[ -n "$restored" ]]; then
    DEP_NAME="$dep_name" DEP_FILE="$dep_file" node -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync("package.json", "utf8"));
      d.dependencies[process.env.DEP_NAME] = process.env.DEP_FILE;
      fs.writeFileSync("package.json", JSON.stringify(d, null, 2) + "\n");
    '
    npm install --no-audit --no-fund
    echo "    restored dev file: dependency"
  fi
}

publish "$TWILL" "@bitwise-operations/twill"
publish "$TWILL_PI" "@bitwise-operations/twill-pi" "@bitwise-operations/twill" "file:$TWILL" "^0.1.0"
publish "$TWILL_PI_WORKSPACE" "@bitwise-operations/twill-pi-workspace" "@bitwise-operations/twill-pi" "file:$TWILL_PI" "^0.1.0"

echo "==> all three published."
