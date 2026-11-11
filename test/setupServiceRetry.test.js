'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { SetupService } = require('../services/setupService');

function createService(t, { envContent, validate }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-setup-'));
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    Object.assign(console, original);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const service = new SetupService();
  service.envPath = path.join(dir, '.env');
  if (envContent !== undefined) {
    fs.writeFileSync(service.envPath, envContent);
  }
  service.retryBaseDelayMs = 20;
  service.retryMaxDelayMs = 80;
  service.calls = 0;
  service.validateConfig = async (config) => {
    service.calls += 1;
    return validate(service.calls, config);
  };
  return service;
}

const ENV = 'PAPERLESS_API_URL=http://paperless.example.com/api\nPAPERLESS_API_TOKEN=token\n';
const unreachable = () => {
  throw new Error('Invalid Paperless configuration');
};

test('a backend that is down at start does not switch the service off for good', async (t) => {
  let up = false;
  const service = createService(t, {
    envContent: ENV,
    validate: () => (up ? true : unreachable())
  });

  assert.equal(await service.isConfigured(), false);
  assert.equal(service.getStatus(), 'waiting');
  assert.equal(service.configured, null);

  // Inside the back-off window the backends are not asked again.
  assert.equal(await service.isConfigured(), false);
  assert.equal(service.calls, 1);

  up = true;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await service.isConfigured(), true);
  assert.equal(service.getStatus(), 'ready');
  assert.equal(service.calls, 2);

  // Confirmed once, never checked again.
  assert.equal(await service.isConfigured(), true);
  assert.equal(service.calls, 2);
});

test('waitUntilConfigured keeps trying far beyond the old five minute limit', async (t) => {
  const service = createService(t, {
    envContent: ENV,
    validate: (call) => (call > 70 ? true : unreachable())
  });
  service.retryBaseDelayMs = 1;
  service.retryMaxDelayMs = 2;

  assert.equal(await service.waitUntilConfigured(), true);
  assert.equal(service.calls, 71);
});

test('the retry delay doubles and is capped', (t) => {
  const service = createService(t, { envContent: ENV, validate: () => true });
  service.retryBaseDelayMs = 5000;
  service.retryMaxDelayMs = 60000;

  const delays = [1, 2, 3, 4, 5, 6, 50].map((attempts) => {
    service.failedAttempts = attempts;
    return service.retryDelayMs();
  });
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test('concurrent callers share one check', async (t) => {
  const service = createService(t, {
    envContent: ENV,
    validate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    }
  });

  const results = await Promise.all([service.isConfigured(), service.isConfigured(), service.isConfigured()]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(service.calls, 1);
});

test('a missing setup is reported as such and not waited for', async (t) => {
  const missing = createService(t, { validate: () => true });
  assert.equal(await missing.waitUntilConfigured(), false);
  assert.equal(missing.getStatus(), 'setup_required');
  assert.equal(missing.calls, 0);

  const incomplete = createService(t, { envContent: 'AI_PROVIDER=custom\n', validate: () => true });
  assert.equal(await incomplete.isConfigured(), false);
  assert.equal(incomplete.getStatus(), 'setup_required');
  assert.equal(incomplete.calls, 0);
});
