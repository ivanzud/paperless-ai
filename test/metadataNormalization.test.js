'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const MetadataNormalizationService = require('../services/metadataNormalizationService');
const RestrictionPromptService = require('../services/restrictionPromptService');
const { normalizeCustomFieldValueForPaperless } = require('../services/serviceUtils');

function withAliases(value, fn) {
  const previous = process.env.METADATA_CORRESPONDENT_ALIASES;
  process.env.METADATA_CORRESPONDENT_ALIASES = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.METADATA_CORRESPONDENT_ALIASES;
    } else {
      process.env.METADATA_CORRESPONDENT_ALIASES = previous;
    }
  }
}

test('maps correspondent variants to the canonical name', () => {
  withAliases(JSON.stringify({ 'Acme Mortgage Servicing LLC': 'Acme Mortgage' }), () => {
    const doc = MetadataNormalizationService.normalizeAnalysisDocument({
      correspondent: '  acme mortgage servicing, llc '
    });
    assert.equal(doc.correspondent, 'Acme Mortgage');
  });
});

test('keeps a correspondent without an alias as written', () => {
  withAliases('{}', () => {
    const doc = MetadataNormalizationService.normalizeAnalysisDocument({ correspondent: 'Example Bank' });
    assert.equal(doc.correspondent, 'Example Bank');
  });
});

test('normalizes date custom fields to YYYY-MM-DD and drops unparseable ones', () => {
  const field = { data_type: 'date' };
  assert.equal(normalizeCustomFieldValueForPaperless('04/01/2026', field), '2026-04-01');
  assert.equal(normalizeCustomFieldValueForPaperless('2026-04-01', field), '2026-04-01');
  assert.equal(normalizeCustomFieldValueForPaperless('upon receipt', field), '');
});

test('normalizes monetary custom fields to a plain decimal', () => {
  assert.equal(normalizeCustomFieldValueForPaperless('$1,234.56', { data_type: 'monetary' }), '1234.56');
});

test('labels the document type list as closed only when restricted', () => {
  assert.match(
    RestrictionPromptService.documentTypesLabel({ restrictToExistingDocumentTypes: 'yes' }),
    /choose exactly one/
  );
  assert.equal(
    RestrictionPromptService.documentTypesLabel({ restrictToExistingDocumentTypes: 'no' }),
    'Pre-existing document types'
  );
});

test('keeps pipeline tags out of the allowed tag list', () => {
  const previous = process.env.AI_PROCESSED_TAG_NAME;
  process.env.AI_PROCESSED_TAG_NAME = 'ai-processed';
  try {
    const prompt = RestrictionPromptService.buildExistingDataPrompt(
      ['Bill', 'ai-processed', 'paperless-gpt-ocr-auto', 'paperless-ai-auto', 'Tax'],
      ['Example Bank'],
      ['Bill'],
      { useExistingData: 'yes', restrictToExistingTags: 'yes', restrictToExistingDocumentTypes: 'yes' }
    );
    assert.match(prompt, /Allowed existing tags \(copy exact names only\): Bill, Tax\n/);
    assert.match(prompt, /Allowed document types \(choose exactly one of these names\): Bill/);
  } finally {
    if (previous === undefined) {
      delete process.env.AI_PROCESSED_TAG_NAME;
    } else {
      process.env.AI_PROCESSED_TAG_NAME = previous;
    }
  }
});
