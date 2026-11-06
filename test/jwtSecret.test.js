'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { resolveJwtSecret } = require('../config/jwtSecret');

function withEnv(value, fn) {
  const previous = process.env.JWT_SECRET;
  if (value === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previous;
    }
  }
}

test('uses JWT_SECRET from the environment', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-'));
  withEnv('from-env', () => {
    assert.equal(resolveJwtSecret(dataDir), 'from-env');
  });
  assert.equal(fs.existsSync(path.join(dataDir, '.jwt_secret')), false);
});

test('generates, persists and reuses a secret when JWT_SECRET is unset', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-'));
  const first = withEnv(undefined, () => resolveJwtSecret(dataDir));
  const second = withEnv(undefined, () => resolveJwtSecret(dataDir));

  assert.match(first, /^[0-9a-f]{128}$/);
  assert.notEqual(first, 'your-secret-key');
  assert.equal(second, first);
  assert.equal(fs.statSync(path.join(dataDir, '.jwt_secret')).mode & 0o777, 0o600);
});
