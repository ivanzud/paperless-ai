#!/usr/bin/env bash
set -euo pipefail

# Goal passes only when all upstream PR backlog tasks are closed.
# Count tasks by label and then exclude closed status in Python.
active_count="$(
  bd list --label upstream-pr --json \
    | python3 -c 'import json,sys; items=json.load(sys.stdin); print(sum(1 for i in items if i.get("status")!="closed"))'
)"

echo "active_upstream_pr_tasks=${active_count}"
[ "${active_count}" -eq 0 ]
