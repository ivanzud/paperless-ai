'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const MetadataNormalizationService = require('../services/metadataNormalizationService');
const {
  normalizeCustomFieldValueForPaperless,
  normalizeDateCustomFieldValue
} = require('../services/serviceUtils');

const MONETARY = { data_type: 'monetary' };
const DATE = { data_type: 'date' };

test('monetary custom field: placeholders and zero are not values', () => {
  for (const value of ['0', '0.00', '$0.00', '', '   ', 'none', 'None', 'N/A', 'n/a', 'null', 'unknown', '-', 'not applicable', 0, null, undefined]) {
    assert.equal(normalizeCustomFieldValueForPaperless(value, MONETARY), '', `value ${JSON.stringify(value)}`);
  }
});

test('monetary custom field: one unambiguous amount becomes a two-decimal number', () => {
  const cases = {
    '$1,234.56': '1234.56',
    '1,763': '1763.00',
    '12,345,678': '12345678.00',
    '1.234,56': '1234.56',
    '12,5': '12.50',
    '7640.8': '7640.80',
    '20': '20.00',
    'USD123.45': '123.45',
    '123.45 USD': '123.45',
    '45.00.': '45.00',
    '0.50': '0.50',
    '(45.00)': '-45.00',
    '-45.00': '-45.00',
    '-$45.5': '-45.50'
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeCustomFieldValueForPaperless(input, MONETARY), expected, `value ${input}`);
  }
  assert.equal(normalizeCustomFieldValueForPaperless(12.5, MONETARY), '12.50');
});

test('monetary custom field: anything ambiguous is dropped instead of guessed', () => {
  for (const value of ['100.00 / 200.00', '45.00-', '1.234', '5%', 'Total 45.00', '45 per month', '12345678901.00', '1,23,4', 'abc']) {
    assert.equal(normalizeCustomFieldValueForPaperless(value, MONETARY), '', `value ${value}`);
  }
});

test('monetary normalization is stable when applied twice', () => {
  for (const value of ['$1,234.56', '(45.00)', '1,763']) {
    const once = normalizeCustomFieldValueForPaperless(value, MONETARY);
    assert.equal(normalizeCustomFieldValueForPaperless(once, MONETARY), once);
  }
});

test('date custom field: accepted formats', () => {
  const now = new Date(2026, 5, 15);
  const cases = {
    '2026-04-01': '2026-04-01',
    '2026-04-01T23:30:00-08:00': '2026-04-01',
    '2026/4/1': '2026-04-01',
    '04/01/2026': '2026-04-01',
    '4/1/2026': '2026-04-01',
    '01/13/26': '2026-01-13',
    '12/15/25': '2025-12-15',
    '1/5/98': '1998-01-05',
    '02-10-2026': '2026-02-10',
    '02/10/2026': '2026-02-10',
    '13/02/2026': '2026-02-13',
    '13.02.2026': '2026-02-13',
    'January 13, 2026': '2026-01-13',
    'Jan 13 2026': '2026-01-13',
    '13 Jan 2026': '2026-01-13',
    'Sept. 3rd, 2026': '2026-09-03',
    'Tuesday, March 3, 2026': '2026-03-03'
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeDateCustomFieldValue(input, now), expected, `value ${input}`);
  }
});

test('date custom field: bare numbers, impossible and implausible dates are dropped', () => {
  const now = new Date(2026, 5, 15);
  for (const value of ['21', '00', '12', '0000', '2026', '02/30/2026', '2026-13-01', '2100-01-01', '0026-01-13', 'May 2026', 'upon receipt', 'N/A', '1-2-3', '']) {
    assert.equal(normalizeDateCustomFieldValue(value, now), '', `value ${value}`);
  }
  assert.equal(normalizeCustomFieldValueForPaperless('upon receipt', DATE), '');
  assert.equal(normalizeCustomFieldValueForPaperless(20260401, DATE), '');
});

test('ambiguous day/month order follows AMBIGUOUS_DATE_ORDER', () => {
  const now = new Date(2026, 5, 15);
  const format = (value, order) => {
    const parsed = MetadataNormalizationService.parseStrictDate(value, { now, order });
    return parsed ? MetadataNormalizationService.formatDate(parsed) : null;
  };
  assert.equal(format('02/10/2026', 'MDY'), '2026-02-10');
  assert.equal(format('02/10/2026', 'DMY'), '2026-10-02');
  assert.equal(format('13/02/2026', 'MDY'), '2026-02-13');
  assert.equal(format('02/13/2026', 'DMY'), '2026-02-13');
});

test('other custom field types drop placeholders and keep real values', () => {
  assert.equal(normalizeCustomFieldValueForPaperless('N/A', { data_type: 'string' }), '');
  assert.equal(normalizeCustomFieldValueForPaperless('Fill in the value based on your analysis', { data_type: 'string' }), '');
  assert.equal(normalizeCustomFieldValueForPaperless(' REF-1234 ', { data_type: 'string' }), 'REF-1234');
  assert.equal(normalizeCustomFieldValueForPaperless(7, { data_type: 'integer' }), 7);
  assert.equal(normalizeCustomFieldValueForPaperless('x'.repeat(200), { data_type: 'string' }).length, 128);
  assert.equal(normalizeCustomFieldValueForPaperless('x'.repeat(200), { data_type: 'longtext' }).length, 200);
});

test('document date from the model is parsed strictly and falls back to the stored date', () => {
  const normalize = (candidate, fallback = '2025-03-04') => MetadataNormalizationService.normalizeDocumentDate(candidate, fallback);
  assert.equal(normalize('2025-02-13'), '2025-02-13');
  assert.equal(normalize('02/13/2025'), '2025-02-13');
  assert.equal(normalize('02-10-2025'), '2025-02-10');
  assert.equal(normalize('01/13/25'), '2025-01-13');
  assert.equal(normalize('February 13, 2025'), '2025-02-13');
  // A bare year used to become January 1st of that year.
  assert.equal(normalize('2025'), '2025-03-04');
  assert.equal(normalize('21'), '2025-03-04');
  assert.equal(normalize('unknown'), '2025-03-04');
  assert.equal(normalize('2999-01-01'), '2025-03-04');
  assert.equal(normalize('1985-06-01'), '2025-03-04');
  assert.equal(normalize('1985-06-01', '1986-01-01'), '1985-06-01');
  assert.equal(normalize('garbage', null), null);
  assert.equal(normalize('2025-02-13', '2025-03-04T00:00:00+00:00'), '2025-02-13');
});
