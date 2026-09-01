'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const paperlessService = require('../services/paperlessService');

test('document list requests use the canonical created field', async (t) => {
  const originalClient = paperlessService.client;
  const originalProcessPredefinedDocuments = process.env.PROCESS_PREDEFINED_DOCUMENTS;
  let requestedFields;

  t.after(() => {
    paperlessService.client = originalClient;
    if (originalProcessPredefinedDocuments === undefined) {
      delete process.env.PROCESS_PREDEFINED_DOCUMENTS;
    } else {
      process.env.PROCESS_PREDEFINED_DOCUMENTS = originalProcessPredefinedDocuments;
    }
  });

  delete process.env.PROCESS_PREDEFINED_DOCUMENTS;
  paperlessService.client = {
    async get(path, options) {
      assert.equal(path, '/documents/');
      requestedFields = options.params.fields.split(',');
      return {
        data: {
          next: null,
          results: []
        }
      };
    }
  };

  await paperlessService.getAllDocuments();

  assert.equal(requestedFields.includes('created'), true);
  assert.equal(requestedFields.includes('created_date'), false);
});
