'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('the snapshot of previous values is stored with the original data', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-db-'));
  const previousCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  process.chdir(workDir);
  t.after(() => {
    console.log = originalLog;
    process.chdir(previousCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // The model opens data/documents.db below the working directory on load.
  const documentModel = require('../models/document');
  const previousValues = {
    title: 'Scan 0001',
    created: '2025-03-04',
    document_type: 2,
    tags: [3, 5],
    custom_fields: [{ field: 1, value: '45.00' }]
  };

  assert.equal(await documentModel.saveOriginalData(42, [3, 5], 8, 'Scan 0001', null, previousValues), true);
  assert.equal(await documentModel.saveOriginalData(43, [], null, 'Scan 0002'), true);

  const stored = await documentModel.getOriginalData(42);
  assert.equal(stored.title, 'Scan 0001');
  assert.deepEqual(JSON.parse(stored.tags), [3, 5]);
  assert.deepEqual(JSON.parse(stored.previous_values), previousValues);
  assert.equal((await documentModel.getOriginalData(43)).previous_values, null);
});
