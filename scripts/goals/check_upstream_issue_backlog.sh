#!/usr/bin/env bash
set -euo pipefail

# Goal passes only when all tracked upstream issue tasks are closed.
active_count="$(
  bd list --label upstream-issue --json \
    | python3 -c 'import json,sys; items=json.load(sys.stdin); print(sum(1 for i in items if i.get("status")!="closed"))'
)"

echo "active_upstream_issue_tasks=${active_count}"
[ "${active_count}" -eq 0 ]
