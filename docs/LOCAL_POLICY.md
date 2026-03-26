# Local Policy Automation

This repository can reapply the local Paperless OCR -> AI handoff policy and metadata normalization rules without storing secrets in git.

## Files

- Tracked template: `config/local/paperless-policy.example.json`
- Local ignored policy: `config/local/paperless-policy.local.json`
- Apply script: `scripts/paperless/applyLocalPolicy.js`

## What the script does

- patches the `paperless-ai` runtime env with the configured metadata normalization keys
- ensures the Paperless pipeline tags exist
- reconciles the OCR -> AI handoff workflows by name
- removes stale end-state workflow tags from documents that already completed the pipeline
- can enforce a scan blocker such as `paperless-gpt-ocr-auto` so `paperless-ai` does not compete with OCR backlog
- restarts `paperless-ai` if the runtime env changed

## Usage

Dry run against the running container:

```bash
node scripts/paperless/applyLocalPolicy.js --container paperless-ai --dry-run
```

Apply the policy:

```bash
node scripts/paperless/applyLocalPolicy.js --container paperless-ai
```

Use a host-side env file instead of reading `/app/data/.env` from the container:

```bash
node scripts/paperless/applyLocalPolicy.js \
  --env-file /path/to/.env \
  --paperless-url http://paperless.example/api \
  --paperless-token <token>
```

## Notes

- The local policy file is ignored from git so property aliases and local naming policy do not get pushed accidentally.
- Useful metadata controls include `tagAliases`, `dropExactTags`, `dropPatterns`, and `keepNumericTags`.
- The script uses only built-in Node modules and Docker/Paperless APIs that are already present in this setup.
