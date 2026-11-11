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

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function silenceWarnings(t) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

const apply = (title) => MetadataNormalizationService.applyTitleReplacements(title);

test('title replacement does not re-expand a name that is already canonical', () => {
  withEnv({
    METADATA_TAG_ALIASES: undefined,
    METADATA_TITLE_REPLACEMENTS: { Jane: 'Jane Doe', Doe: 'Jane Doe', 'JANE DOE': 'Jane Doe', 1234: 'Maple Court' }
  }, () => {
    assert.equal(apply('Phone Invoice 2025 - Jane Doe'), 'Phone Invoice 2025 - Jane Doe');
    assert.equal(apply('Phone Invoice 2025 - JANE DOE'), 'Phone Invoice 2025 - Jane Doe');
    assert.equal(apply('401(k) Statement - Jane'), '401(k) Statement - Jane Doe');
    assert.equal(apply('Water Bill - 1234'), 'Water Bill - Maple Court');
    assert.equal(apply('Account 12341'), 'Account 12341');
  });
});

test('tag aliases are not applied to titles', () => {
  withEnv({
    METADATA_TAG_ALIASES: { 1234: 'Maple Court', Doe: 'Jane Doe', JD: 'Jane Doe', Acme: 'Acme Financial' },
    METADATA_TITLE_REPLACEMENTS: undefined
  }, () => {
    for (const title of [
      'Payment $1234.00 - Example Bank',
      'Invoice #1234 - Acme',
      'John Doe - Medical',
      'JD Holdings Invoice',
      'Acme Life Insurance Annual Statement 2025'
    ]) {
      assert.equal(apply(title), title);
      assert.equal(MetadataNormalizationService.normalizeTitle(title, 'Scan'), title);
    }
    // The aliases still do their job on tags.
    assert.deepEqual(
      MetadataNormalizationService.normalizeTags(['1234', 'JD', 'Acme'], 4),
      ['Maple Court', 'Jane Doe', 'Acme Financial']
    );
  });
});

test('title replacements leave amounts, identifiers and parts of other tokens alone', () => {
  withEnv({
    METADATA_TAG_ALIASES: undefined,
    METADATA_TITLE_REPLACEMENTS: { 1234: 'Maple Court', '1234 Maple Court Dr': 'Maple Court', Jane: 'Jane Doe', 'ACME CORP': 'Acme' }
  }, () => {
    const unchanged = [
      'Payment $1234.00 - Example Bank',
      'Payment 1234.50 - Example Bank',
      'Invoice #1234 - Example Store',
      'Credit Card Statement ending 1234 - Example Bank',
      'Order 1234-1',
      'Order 7-1234',
      'Check 1234',
      'Form 1234 2025',
      'Ref 12/1234',
      'Mail from jane@example.com',
      'Mary-Jane Roe - Medical',
      'Janet Roe - Medical'
    ];
    for (const title of unchanged) {
      assert.equal(apply(title), title);
    }

    assert.equal(apply('Water Bill 2025 - 1234'), 'Water Bill 2025 - Maple Court');
    assert.equal(apply('1234 - Water Bill 2025'), 'Maple Court - Water Bill 2025');
    assert.equal(apply('Water Bill - 1234 Maple Court Dr'), 'Water Bill - Maple Court');
    assert.equal(apply('Statement - Jane, 2025'), 'Statement - Jane Doe, 2025');
    assert.equal(apply('Invoice (ACME CORP)'), 'Invoice (Acme)');
  });
});

test('property suffix rewrite keeps the person on personal documents', () => {
  withEnv({
    METADATA_PROPERTY_TAGS: 'Maple Court,Oak',
    METADATA_TAG_ALIASES: { 1234: 'Maple Court', '456 Oak Ave': 'Oak' },
    METADATA_TITLE_REPLACEMENTS: undefined
  }, () => {
    const rewrite = (title, tags = ['Bill', 'Maple Court']) => MetadataNormalizationService.rewritePropertyTitleSuffix(title, tags);

    for (const title of [
      '401(k) Statement 2024 - Jane Doe',
      'Credit Card Statement - Jane Doe',
      'Toll Invoice August 2025 - John Doe',
      'Vehicle Registration 2025 - Jane Doe',
      'Health Statement January 2026 - Jane Doe',
      'Phone Bill March 2025 - John Doe',
      'W-2 2024 - Jane Doe',
      'Tax Notice 2025 - Jane Doe',
      'Receipt - Jane & John Doe',
      'Auto Insurance Policy and Home Insurance Bundle - Jane Doe'
    ]) {
      assert.equal(rewrite(title), title);
    }

    // Documents about the property get the property.
    assert.equal(rewrite('Water Bill March 2025 - Jane Doe'), 'Water Bill March 2025 - Maple Court');
    assert.equal(rewrite('Property Tax Statement 2025 - Jane & John Doe'), 'Property Tax Statement 2025 - Maple Court');
    assert.equal(rewrite('HOA Assessment 2025 - JANE DOE'), 'HOA Assessment 2025 - Maple Court');
    assert.equal(rewrite('Mortgage Statement - Jane Doe'), 'Mortgage Statement - Maple Court');

    // An address is replaced only by the property it belongs to.
    assert.equal(rewrite('Statement 2025 - 1234 Maple Court Dr'), 'Statement 2025 - Maple Court');
    assert.equal(rewrite('Statement 2025 - 456 Oak Ave', ['Maple Court', 'Oak']), 'Statement 2025 - Oak');
    assert.equal(rewrite('Statement 2025 - 99 Elm Street'), 'Statement 2025 - 99 Elm Street');

    // No property tag, nothing to do.
    assert.equal(rewrite('Water Bill March 2025 - Jane Doe', ['Bill']), 'Water Bill March 2025 - Jane Doe');
    assert.equal(rewrite('Water Bill March 2025 - Maple Court'), 'Water Bill March 2025 - Maple Court');
  });
});

test('tag drop rules', () => {
  withEnv({
    METADATA_TAG_ALIASES: { '123 Main St': 'Main' },
    METADATA_PROPERTY_TAGS: 'Main',
    METADATA_DROP_ADDRESS_TAGS: 'yes',
    METADATA_TAG_DROP_EXACT: ['Misc'],
    METADATA_TAG_DROP_PATTERNS: ['^Q[1-4]\\s+\\d{4}$'],
    METADATA_KEEP_NUMERIC_TAGS: ['1234']
  }, () => {
    const name = (tag) => MetadataNormalizationService.normalizeTagName(tag);
    assert.equal(name('Misc'), null);
    assert.equal(name('misc'), null);
    assert.equal(name('Q3 2025'), null);
    assert.equal(name('March 2024'), null);
    assert.equal(name('98765'), null);
    assert.equal(name('1234'), '1234');
    assert.equal(name('2024'), '2024');
    assert.equal(name('456 Oak Ave'), null);
    assert.equal(name('123 Main St'), 'Main');
    assert.equal(name(' -Bill, '), 'Bill');
    assert.equal(name('INSURANCE'), 'Insurance');
    assert.equal(name(''), null);
    assert.equal(name(42), null);
  });
});

test('a double-escaped drop pattern is repaired and reported', (t) => {
  const warnings = silenceWarnings(t);
  withEnv({
    // What the app sees after one JSON encoding too many: two backslashes.
    METADATA_TAG_DROP_PATTERNS: JSON.stringify(['^Q[1-4]\\\\s+\\\\d{4}$', '^Draft\\b'])
  }, () => {
    assert.equal(MetadataNormalizationService.getRules().dropTagPatterns[0].source, '^Q[1-4]\\s+\\d{4}$');
    assert.equal(MetadataNormalizationService.normalizeTagName('Q3 2025'), null);
    assert.equal(MetadataNormalizationService.normalizeTagName('Draft Copy'), null);
    assert.equal(MetadataNormalizationService.normalizeTagName('Bill'), 'Bill');
  });
  assert.equal(warnings.filter((line) => line.includes('double-escaped')).length, 1);
});

test('the example policy carries drop patterns that compile to what they say', () => {
  const policy = require('../config/local/paperless-policy.example.json');
  withEnv({ METADATA_TAG_DROP_PATTERNS: JSON.stringify(policy.metadata.dropPatterns) }, () => {
    const patterns = MetadataNormalizationService.getRules().dropTagPatterns;
    assert.equal(patterns.length, policy.metadata.dropPatterns.length);
    assert.equal(patterns.some((pattern) => pattern.test('March 2024')), true);
    assert.equal(patterns.some((pattern) => pattern.source.includes('\\\\')), false);
  });
});

test('normalizeTags removes duplicates and caps the number of tags', () => {
  withEnv({ METADATA_TAG_ALIASES: undefined, METADATA_TAG_DROP_EXACT: undefined, METADATA_TAG_DROP_PATTERNS: undefined }, () => {
    assert.deepEqual(
      MetadataNormalizationService.normalizeTags(['Bill', 'bill', 'Tax', '98765', 'Insurance', 'Bank', 'Utility'], 4),
      ['Bill', 'Tax', 'Insurance', 'Bank']
    );
    assert.deepEqual(MetadataNormalizationService.normalizeTags('Bill', 4), []);
  });
});
