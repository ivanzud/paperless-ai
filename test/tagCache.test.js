'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const CONFIG_PATH = require.resolve('../config/config');
const SERVICE_PATH = require.resolve('../services/paperlessService');
const TUNABLES = ['TAG_CACHE_LIFETIME', 'TAG_PAGE_SIZE'];

function loadService(env = {}) {
  const savedEnv = Object.fromEntries(TUNABLES.map((key) => [key, process.env[key]]));

  for (const key of TUNABLES) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(env[key]);
    }
  }

  delete require.cache[CONFIG_PATH];
  delete require.cache[SERVICE_PATH];
  const service = require(SERVICE_PATH);

  for (const key of TUNABLES) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  return service;
}

function fakeClient(pages) {
  const requested = [];

  return {
    requested,
    defaults: { baseURL: 'http://paperless.local/api' },
    get: async (url) => {
      requested.push(url);
      const page = pages[requested.length - 1];
      if (!page) {
        throw new Error(`Unexpected request #${requested.length} to ${url}`);
      }
      return { data: page };
    }
  };
}

function tags(startId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    name: `Tag ${startId + index}`
  }));
}

const onePage = [{ results: [{ id: 1, name: 'Invoice' }], next: null }];

test('tag cache defaults to a three-second lifetime and page size 100', () => {
  const service = loadService();

  assert.equal(service.TAG_CACHE_LIFETIME, 3000);
  assert.equal(service.TAG_PAGE_SIZE, 100);
});

test('refreshTagCache fetches every page with the configured page size', async () => {
  const service = loadService({ TAG_PAGE_SIZE: 100 });
  const client = fakeClient([
    {
      results: tags(1, 100),
      next: 'http://paperless.local/api/tags/?page=2&page_size=100'
    },
    { results: tags(101, 64), next: null }
  ]);
  service.client = client;

  await service.refreshTagCache();

  assert.deepEqual(client.requested, [
    '/tags/?page_size=100',
    '/tags/?page=2&page_size=100'
  ]);
  assert.equal(service.tagCache.size, 164);
  assert.equal(service.tagIdCache.size, 164);
  assert.equal(service.tagNormalizedCache.size, 164);
});

test('refreshTagCache honors a custom page size', async () => {
  const service = loadService({ TAG_PAGE_SIZE: 250 });
  const client = fakeClient(onePage);
  service.client = client;

  await service.refreshTagCache();

  assert.deepEqual(client.requested, ['/tags/?page_size=250']);
});

test('invalid tag cache settings fall back to safe defaults', () => {
  const invalidValues = [
    '',
    '0',
    '-5',
    '1.5',
    '1e3',
    '100junk',
    'Infinity',
    '9007199254740992',
    'not-a-number'
  ];

  for (const value of invalidValues) {
    const service = loadService({ TAG_CACHE_LIFETIME: value, TAG_PAGE_SIZE: value });
    assert.equal(service.TAG_CACHE_LIFETIME, 3000, `TAG_CACHE_LIFETIME=${value}`);
    assert.equal(service.TAG_PAGE_SIZE, 100, `TAG_PAGE_SIZE=${value}`);
  }
});

test('ensureTagCache reuses a one-hour cache while it is fresh', async () => {
  const service = loadService({ TAG_CACHE_LIFETIME: 3600000 });
  const client = fakeClient(onePage);
  service.client = client;

  await service.ensureTagCache();
  await service.ensureTagCache();
  await service.ensureTagCache();

  assert.equal(service.TAG_CACHE_LIFETIME, 3600000);
  assert.equal(service.CACHE_LIFETIME, 3000, 'document type cache behavior must remain unchanged');
  assert.equal(client.requested.length, 1);
});

test('ensureTagCache refreshes after the configured lifetime elapses', async () => {
  const service = loadService({ TAG_CACHE_LIFETIME: 3600000 });
  const client = fakeClient([...onePage, ...onePage]);
  service.client = client;

  await service.ensureTagCache();
  service.lastTagRefresh = Date.now() - 3600001;
  await service.ensureTagCache();

  assert.equal(client.requested.length, 2);
});
