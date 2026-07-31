'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entrypoint = path.join(__dirname, '..', 'docker', 'paperless-ai-entrypoint.sh');

function runEntrypoint(puid, pgid) {
  return spawnSync('bash', [entrypoint, 'true'], {
    env: {
      ...process.env,
      PUID: puid,
      PGID: pgid
    },
    encoding: 'utf8'
  });
}

test('entrypoint rejects non-numeric identities', () => {
  const result = runEntrypoint('invalid', '1000');

  assert.equal(result.status, 64);
  assert.match(result.stderr, /PUID and PGID must be numeric/);
});

test('entrypoint rejects root identities', () => {
  const result = runEntrypoint('0', '1000');

  assert.equal(result.status, 64);
  assert.match(result.stderr, /PUID and PGID must be non-zero/);
});
