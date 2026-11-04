#!/usr/bin/env bash
# Signs the extension for Firefox as an unlisted add-on on addons.mozilla.org:
# not published in the store, the signed .xpi is installable in any Firefox.
#
# Needs AMO API credentials (addons.mozilla.org > Developer Hub > Manage API Keys),
# either exported or in a local .env file (git-ignored):
#   WEB_EXT_API_KEY=user:12345:678
#   WEB_EXT_API_SECRET=...
#
# Usage: tools/firefox-sign.sh [--bump]
#   --bump  raises the patch version in manifest.json first (AMO refuses to sign
#           the same version twice)
# Output: web-ext-artifacts/*.xpi
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
: "${WEB_EXT_API_KEY:?Set WEB_EXT_API_KEY (AMO JWT issuer) in the environment or .env}"
: "${WEB_EXT_API_SECRET:?Set WEB_EXT_API_SECRET (AMO JWT secret) in the environment or .env}"

if [ "${1:-}" = "--bump" ]; then
  node -e '
    const fs = require("fs");
    const text = fs.readFileSync("manifest.json", "utf8");
    const m = JSON.parse(text);
    const parts = m.version.split(".").map(Number);
    parts[parts.length - 1] += 1;
    const next = parts.join(".");
    fs.writeFileSync("manifest.json", text.replace(`"version": "${m.version}"`, `"version": "${next}"`));
    console.log(`version ${m.version} -> ${next}`);
  '
fi

# Development files that do not belong in the package
IGNORE=("tests" "tests/**" "fixtures" "fixtures/**" "tools" "tools/**" "brag-output" "brag-output/**" "web-ext-artifacts" "web-ext-artifacts/**" "CLAUDE.md" "README.md" "*.zip" "*.xpi")

npx --yes web-ext lint --source-dir . --ignore-files "${IGNORE[@]}"
npx --yes web-ext sign --channel=unlisted --source-dir . --artifacts-dir web-ext-artifacts --ignore-files "${IGNORE[@]}"
ls -l web-ext-artifacts/*.xpi
