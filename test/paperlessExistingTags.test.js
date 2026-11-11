'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { PaperlessService } = require('../services/paperlessService');

const TAGS = [
  { id: 1, name: 'Bill' },
  { id: 2, name: '1234' },
  { id: 3, name: '5550001111' },
  { id: 4, name: 'March 2025' },
  { id: 5, name: 'Maple Court' },
  { id: 6, name: 'JD' },
  { id: 7, name: 'ai-processed' }
];

const RULES = {
  METADATA_TAG_ALIASES: JSON.stringify({ 1234: 'Maple Court', JD: 'Jane Doe' }),
  METADATA_TAG_DROP_PATTERNS: JSON.stringify(['^(January|February|March)\\s+\\d{4}$']),
  METADATA_KEEP_NUMERIC_TAGS: '',
  METADATA_PROPERTY_TAGS: 'Maple Court'
};

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function createService(t, currentDoc) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => Object.assign(console, original));

  const service = new PaperlessService();
  const patches = [];
  const created = [];
  service.client = {
    async patch(url, payload) {
      patches.push(JSON.parse(JSON.stringify(payload)));
      return { data: {} };
    },
    async get() {
      return { data: { results: [] } };
    }
  };
  service.ensureTagCache = async () => {};
  for (const tag of TAGS) {
    service.tagIdCache.set(tag.id, tag);
    service.tagCache.set(tag.name.toLowerCase(), tag);
  }
  service.createTagSafely = async (name) => {
    const tag = { id: 100 + created.length, name };
    created.push(name);
    return tag;
  };
  service.getDocument = async () => currentDoc;
  return { service, patches, created };
}

test('tags a document already has are sent back untouched', async (t) => {
  const { service, patches, created } = createService(t, {
    id: 9, title: 'Scan', tags: [3, 2, 4, 6], correspondent: null, storage_path: null
  });

  await withEnv({ ...RULES, RESTRICT_TO_EXISTING_TAGS: 'yes' }, () => service.updateDocument(9, {
    title: 'Water Bill March 2025 - Maple Court',
    tags: [1, 7]
  }));

  assert.equal(patches.length, 1);
  // A numeric tag, an alias source and a tag matching a drop pattern all stay.
  assert.deepEqual(patches[0].tags, [3, 2, 4, 6, 1, 7]);
  assert.deepEqual(created, []);
});

test('drop and alias rules still apply to the tags the model proposes', async (t) => {
  const { service, patches } = createService(t, {
    id: 9, title: 'Scan', tags: [3], correspondent: null, storage_path: null
  });

  await withEnv({ ...RULES, RESTRICT_TO_EXISTING_TAGS: 'yes' }, () => service.updateDocument(9, {
    title: 'Water Bill',
    tags: [1, 2, 4, 7]
  }));

  // 1234 -> Maple Court (id 5), "March 2025" dropped, existing tag 3 kept.
  assert.deepEqual(patches[0].tags, [3, 1, 5, 7]);
});

test('an alias target is not created while new tags are not allowed', async (t) => {
  const { service, patches, created } = createService(t, {
    id: 9, title: 'Scan', tags: [], correspondent: null, storage_path: null
  });

  await withEnv({ ...RULES, RESTRICT_TO_EXISTING_TAGS: 'yes' }, () => service.updateDocument(9, {
    title: 'Statement',
    tags: [6]
  }));
  assert.deepEqual(created, []);
  assert.deepEqual(patches[0].tags, [6]);

  await withEnv({ ...RULES, RESTRICT_TO_EXISTING_TAGS: 'no' }, () => service.updateDocument(9, {
    title: 'Statement',
    tags: [6]
  }));
  assert.deepEqual(created, ['Jane Doe']);
  assert.deepEqual(patches[1].tags, [100]);
});
