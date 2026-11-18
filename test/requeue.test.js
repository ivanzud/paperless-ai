'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createRequeueDetector } = require('../services/requeueService');

const PROCESSED_TAG = { id: 5, name: 'ai-processed' };
const QUEUE_TAG = 4;
const ENV = {
  PROCESS_PREDEFINED_DOCUMENTS: 'yes',
  ADD_AI_PROCESSED_TAG: 'yes',
  AI_PROCESSED_TAG_NAME: 'ai-processed'
};

function setup({ processed = true, env = ENV, tag = PROCESSED_TAG, lookupFails = false } = {}) {
  const deleted = [];
  const documentModel = {
    isDocumentProcessed: async () => processed,
    deleteDocumentsIdList: async (ids) => { deleted.push(...ids); return true; }
  };
  const paperlessService = {
    findExistingTag: async (name) => {
      if (lookupFails) throw new Error('paperless is down');
      return tag && tag.name === name ? tag : null;
    }
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const detector = createRequeueDetector({ documentModel, paperlessService, env });
  const restore = () => { console.log = originalLog; console.warn = originalWarn; };
  return { detector, deleted, restore };
}

async function run(options, doc) {
  const { detector, deleted, restore } = setup(options);
  try {
    return { skipped: await detector.isProcessed(doc), deleted };
  } finally {
    restore();
  }
}

test('a document that was never processed is processed', async () => {
  const result = await run({ processed: false }, { id: 1, tags: [QUEUE_TAG] });
  assert.deepEqual(result, { skipped: false, deleted: [] });
});

test('a processed document that still carries the processed tag is left alone', async () => {
  const result = await run({}, { id: 1, tags: [QUEUE_TAG, PROCESSED_TAG.id] });
  assert.deepEqual(result, { skipped: true, deleted: [] });
});

test('a processed document back in the queue without the processed tag is processed again', async () => {
  const result = await run({}, { id: 1, tags: [QUEUE_TAG] });
  assert.deepEqual(result, { skipped: false, deleted: [1] });
});

const neverRequeued = [
  ['the processed tag is not added', { ...ENV, ADD_AI_PROCESSED_TAG: 'no' }, {}],
  ['all documents are processed, not a queue', { ...ENV, PROCESS_PREDEFINED_DOCUMENTS: 'no' }, {}],
  ['the processed tag has no name', { ...ENV, AI_PROCESSED_TAG_NAME: ' ' }, {}],
  ['the processed tag does not exist in Paperless', ENV, { tag: null }],
  ['the tag lookup fails', ENV, { lookupFails: true }]
];

for (const [name, env, options] of neverRequeued) {
  test(`a processed document is left alone when ${name}`, async () => {
    const result = await run({ env, ...options }, { id: 1, tags: [QUEUE_TAG] });
    assert.deepEqual(result, { skipped: true, deleted: [] });
  });
}

test('a processed document without a tag list is left alone', async () => {
  const result = await run({}, { id: 1 });
  assert.deepEqual(result, { skipped: true, deleted: [] });
});
