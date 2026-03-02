#!/usr/bin/env bash
set -euo pipefail

# Verify fork repository and default branch are reachable.
ok="$(gh repo view ivanzud/paperless-ai --json nameWithOwner,defaultBranchRef --jq '.nameWithOwner == "ivanzud/paperless-ai" and .defaultBranchRef.name == "main"')"
[ "$ok" = "true" ]

# Verify the main branch ref can be resolved over git.
git ls-remote --exit-code fork refs/heads/main >/dev/null

echo "fork/main reachable"
