'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// The model opens data/documents.db below the working directory on load.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-failed-'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
const documentModel = require('../models/document');
const { saveAnalyzedDocumentChanges } = require('../services/documentUpdateService');
const RestrictionPromptService = require('../services/restrictionPromptService');
const {
  createFailedDocumentTracker,
  getFailedTagName,
  getMaxAttempts,
  isBackendUnavailable
} = require('../services/failedDocumentService');
console.log = originalConsole.log;

const QUEUE_TAG = 7;
const FAILED_TAG = { id: 99, name: 'paperless-ai-failed' };

// A Paperless stand-in holding the tags of the documents under test.
function createPaperless({ failedTagExists = true } = {}) {
  const paperless = {
    documents: new Map(),
    tags: failedTagExists ? [FAILED_TAG] : [],
    createdTags: [],
    patches: [],
    failPatch: false,
    async findExistingTag(name) {
      return paperless.tags.find((tag) => tag.name === name) || null;
    },
    async createTagSafely(name) {
      const tag = { id: 100 + paperless.tags.length, name };
      paperless.tags.push(tag);
      paperless.createdTags.push(name);
      return tag;
    },
    async getDocument(id) {
      return { id, tags: [...(paperless.documents.get(id) || [QUEUE_TAG])] };
    },
    async patchDocumentMetadata(id, update) {
      if (paperless.failPatch) {
        throw Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:8000'), { code: 'ECONNREFUSED' });
      }
      paperless.patches.push({ id, update });
      paperless.documents.set(id, update.tags);
    }
  };
  return paperless;
}

function setup(t, { env = {}, paperless = createPaperless() } = {}) {
  console.log = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, originalConsole));
  return { paperless, tracker: createFailedDocumentTracker({ documentModel, paperlessService: paperless, env }) };
}

const invalidAnswer = new Error('[ERROR] Document analysis failed: Invalid JSON response from API');

test('a document is tried again until the limit, then tagged and left alone', async (t) => {
  const { paperless, tracker } = setup(t);
  const doc = { id: 501, title: 'Scan 0501', tags: [QUEUE_TAG] };

  assert.equal(await tracker.shouldSkip(doc), false);
  assert.deepEqual(await tracker.recordFailure(doc, invalidAnswer), { counted: true, attempts: 1, gaveUp: false });
  assert.equal(await tracker.shouldSkip(doc), false);
  assert.deepEqual(await tracker.recordFailure(doc, invalidAnswer), { counted: true, attempts: 2, gaveUp: false });
  assert.equal(paperless.patches.length, 0);

  assert.deepEqual(await tracker.recordFailure(doc, invalidAnswer), { counted: true, attempts: 3, gaveUp: true });
  // The marker is added; the tags the document already had stay.
  assert.deepEqual(paperless.patches, [{ id: 501, update: { tags: [QUEUE_TAG, FAILED_TAG.id] } }]);

  assert.equal(await tracker.shouldSkip({ ...doc, tags: [QUEUE_TAG, FAILED_TAG.id] }), true);
  assert.equal(paperless.patches.length, 1);
  const stored = await documentModel.getProcessingFailure(501);
  assert.equal(stored.attempts, 3);
  assert.equal(stored.tagged, 1);
  assert.match(stored.last_error, /Invalid JSON response/);
});

test('removing the failed tag in Paperless asks for another round of attempts', async (t) => {
  const { tracker } = setup(t);
  const doc = { id: 502, title: 'Scan 0502', tags: [QUEUE_TAG] };
  for (let i = 0; i < 3; i += 1) {
    await tracker.recordFailure(doc, invalidAnswer);
  }
  assert.equal(await tracker.shouldSkip({ ...doc, tags: [QUEUE_TAG, FAILED_TAG.id] }), true);

  assert.equal(await tracker.shouldSkip({ ...doc, tags: [QUEUE_TAG] }), false);
  assert.equal(await documentModel.getProcessingFailure(502), null);
  assert.deepEqual(await tracker.recordFailure(doc, invalidAnswer), { counted: true, attempts: 1, gaveUp: false });
});

test('an unreachable backend is not counted against the document', async (t) => {
  const { paperless, tracker } = setup(t);
  const doc = { id: 503, title: 'Scan 0503', tags: [QUEUE_TAG] };
  const outages = [
    new Error('[ERROR] Document analysis failed: Document analysis failed for all chunks. Details: chunk 1: Connection error.'),
    new Error('[ERROR] Document analysis failed: Document analysis failed for all chunks. Details: chunk 1: 503 status code (no body)'),
    Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }),
    Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:8000'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
    new Error('timeout of 30000ms exceeded')
  ];

  for (const outage of outages) {
    assert.equal(isBackendUnavailable(outage), true, outage.message);
    assert.deepEqual(await tracker.recordFailure(doc, outage), { counted: false, attempts: 0, gaveUp: false });
  }
  assert.equal(await documentModel.getProcessingFailure(503), null);
  assert.equal(paperless.patches.length, 0);

  // Failures that are about the document itself do count.
  assert.equal(isBackendUnavailable(invalidAnswer), false);
  assert.equal(isBackendUnavailable(new Error('Document has no text content')), false);
  assert.equal(isBackendUnavailable(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } })), false);
  assert.equal(isBackendUnavailable(new Error('chunk 1: 400 request (9000 tokens) exceeds the available context size (8192 tokens)')), false);
});

test('a tag that could not be set is set at a later scan, and the document is skipped meanwhile', async (t) => {
  const { paperless, tracker } = setup(t);
  const doc = { id: 504, title: 'Scan 0504', tags: [QUEUE_TAG] };
  paperless.failPatch = true;
  for (let i = 0; i < 3; i += 1) {
    await tracker.recordFailure(doc, invalidAnswer);
  }
  assert.equal((await documentModel.getProcessingFailure(504)).tagged, 0);

  paperless.failPatch = false;
  assert.equal(await tracker.shouldSkip(doc), true);
  assert.deepEqual(paperless.patches, [{ id: 504, update: { tags: [QUEUE_TAG, FAILED_TAG.id] } }]);
  assert.equal((await documentModel.getProcessingFailure(504)).tagged, 1);
});

test('the limit and the tag name are configurable, and 0 switches the limit off', async (t) => {
  assert.equal(getMaxAttempts({}), 3);
  assert.equal(getMaxAttempts({ MAX_PROCESSING_ATTEMPTS: '5' }), 5);
  assert.equal(getMaxAttempts({ MAX_PROCESSING_ATTEMPTS: 'many' }), 3);
  assert.equal(getFailedTagName({}), 'paperless-ai-failed');
  assert.equal(getFailedTagName({ AI_FAILED_TAG_NAME: ' needs-review ' }), 'needs-review');

  const custom = setup(t, {
    env: { MAX_PROCESSING_ATTEMPTS: '1', AI_FAILED_TAG_NAME: 'needs-review' },
    paperless: createPaperless({ failedTagExists: false })
  });
  const doc = { id: 505, title: 'Scan 0505', tags: [QUEUE_TAG] };
  assert.equal((await custom.tracker.recordFailure(doc, invalidAnswer)).gaveUp, true);
  assert.deepEqual(custom.paperless.createdTags, ['needs-review']);
  assert.equal(custom.paperless.patches.length, 1);

  const unlimited = setup(t, { env: { MAX_PROCESSING_ATTEMPTS: '0' } });
  const other = { id: 506, title: 'Scan 0506', tags: [QUEUE_TAG] };
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await unlimited.tracker.recordFailure(other, invalidAnswer)).counted, false);
  }
  assert.equal(await unlimited.tracker.shouldSkip(other), false);
  assert.equal(await documentModel.getProcessingFailure(506), null);
});

test('a successful update and a reset both clear the failure count', async (t) => {
  const { tracker } = setup(t);
  const doc = { id: 507, title: 'Scan 0507', tags: [QUEUE_TAG] };
  await tracker.recordFailure(doc, invalidAnswer);
  await tracker.recordFailure(doc, invalidAnswer);

  await saveAnalyzedDocumentChanges({
    documentModel,
    paperlessService: { updateDocument: async () => ({ id: 507 }) },
    documentId: 507,
    statusTitle: 'Scan 0507',
    updateData: { title: 'Acme Invoice - March 2025', tags: [QUEUE_TAG] },
    analysis: { document: { correspondent: 'Acme' }, metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    originalData: { title: 'Scan 0507', tags: [QUEUE_TAG], correspondent: null }
  });
  assert.equal(await documentModel.getProcessingFailure(507), null);

  await tracker.recordFailure({ id: 508, tags: [QUEUE_TAG] }, invalidAnswer);
  await documentModel.deleteDocumentsIdList([508]);
  assert.equal(await documentModel.getProcessingFailure(508), null);
});

test('the failed tag is never offered to the model as an ordinary tag', (t) => {
  const previous = process.env.AI_FAILED_TAG_NAME;
  process.env.AI_FAILED_TAG_NAME = 'needs-review';
  t.after(() => {
    if (previous === undefined) delete process.env.AI_FAILED_TAG_NAME; else process.env.AI_FAILED_TAG_NAME = previous;
  });

  assert.equal(RestrictionPromptService.isPipelineTag('paperless-ai-failed'), true);
  assert.equal(RestrictionPromptService.isPipelineTag('Needs-Review'), true);
  assert.equal(RestrictionPromptService.isPipelineTag('Invoice'), false);
});
