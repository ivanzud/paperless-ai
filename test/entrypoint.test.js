'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

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

test('compose init capabilities remain identical and permit signal forwarding', () => {
  const composeFiles = ['docker-compose.yml', 'docker-compose.ghcr.yml'];
  const expectedCapabilities = [
    'CHOWN',
    'DAC_OVERRIDE',
    'KILL',
    'SETGID',
    'SETUID'
  ];

  for (const composeFile of composeFiles) {
    const compose = yaml.load(
      fs.readFileSync(path.join(__dirname, '..', composeFile), 'utf8')
    );
    const service = compose.services['paperless-ai'];

    assert.equal(service.init, true, composeFile);
    assert.deepEqual(service.cap_drop, ['ALL'], composeFile);
    assert.deepEqual(
      [...service.cap_add].sort(),
      expectedCapabilities,
      composeFile
    );
    assert.equal(
      service.security_opt.includes('no-new-privileges=true'),
      true,
      composeFile
    );
  }
});
