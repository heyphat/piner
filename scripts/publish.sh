#!/usr/bin/env bash
#
# Publish `piner` to the public npm registry.
#
# Normally you don't run this by hand — pushing a `vX.Y.Z` tag triggers the
# Release workflow (.github/workflows/release.yml), which publishes with npm
# provenance. This script is the manual fallback.
#
# Auth: either run `npm login` first, or export an npm automation token:
#
#   NPM_TOKEN=<npm-automation-token> ./scripts/publish.sh
#
# The token is written to a TEMPORARY npmrc created outside the repo with mktemp,
# used for the single `npm publish`, and deleted on exit. It never touches the
# repo, package.json, or your global npm config.
#
set -euo pipefail

# --- run from the package root (this script lives in <root>/scripts) ---
cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"

echo "Publishing ${PKG_NAME}@${PKG_VERSION} → public npm…"

# package.json's prepublishOnly rebuilds dist; publishConfig.access is public.
if [[ -n "${NPM_TOKEN:-}" ]]; then
  TMP_NPMRC="$(mktemp -t piner-npmrc.XXXXXX)"
  cleanup() { rm -f "${TMP_NPMRC}"; }
  trap cleanup EXIT
  cat > "${TMP_NPMRC}" <<EOF
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF
  npm publish --userconfig "${TMP_NPMRC}" --access public
else
  # relies on an existing `npm login` session (may prompt for 2FA)
  npm publish --access public
fi

echo "✓ Published ${PKG_NAME}@${PKG_VERSION}"
