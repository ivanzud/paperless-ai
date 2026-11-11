'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const dotenv = require('dotenv');

const { buildEnvUpdates, formatEnvValue, updateEnvContent } = require('../scripts/paperless/applyLocalPolicy');

const PROMPT_LINES = [
  'SYSTEM_PROMPT=`You label documents.',
  'TAGS=never part of the prompt as a setting',
  'Rule: return JSON only.',
  '`'
];

test('updateEnvContent replaces, appends and keeps everything else as it was', () => {
  const before = [
    '# settings',
    'PAPERLESS_API_URL=http://paperless.example.com/api',
    'TAGS=old-tag',
    '',
    'SCAN_INTERVAL=*/30 * * * *'
  ].join('\n') + '\n';

  const after = updateEnvContent(before, { TAGS: 'paperless-ai-auto', NEW_KEY: 'yes' });

  assert.equal(after, [
    '# settings',
    'PAPERLESS_API_URL=http://paperless.example.com/api',
    'TAGS=paperless-ai-auto',
    '',
    'SCAN_INTERVAL=*/30 * * * *',
    'NEW_KEY=yes'
  ].join('\n') + '\n');
  assert.equal(updateEnvContent(after, { TAGS: 'paperless-ai-auto', NEW_KEY: 'yes' }), after);
});

test('updateEnvContent does not touch lines inside a multi-line quoted value', () => {
  const before = ['API_KEY=abc', ...PROMPT_LINES, 'TAGS=old-tag'].join('\n') + '\n';

  const after = updateEnvContent(before, { TAGS: 'paperless-ai-auto' });

  assert.equal(after, ['API_KEY=abc', ...PROMPT_LINES, 'TAGS=paperless-ai-auto'].join('\n') + '\n');
  const parsed = dotenv.parse(after);
  assert.equal(parsed.TAGS, 'paperless-ai-auto');
  assert.match(parsed.SYSTEM_PROMPT, /^You label documents\.\nTAGS=never part/);
});

test('updateEnvContent replaces a multi-line value as a whole', () => {
  const before = [...PROMPT_LINES, 'TAGS=old-tag'].join('\n') + '\n';
  const after = updateEnvContent(before, { SYSTEM_PROMPT: 'Short prompt' });
  assert.equal(after, 'SYSTEM_PROMPT=Short prompt\nTAGS=old-tag\n');
});

test('a value with a hash sign survives the round trip through dotenv', () => {
  const aliases = JSON.stringify({ 'Unit #5': 'Maple Court', '1234 Oak Ave #2': 'Oak' });
  const after = updateEnvContent('METADATA_TAG_ALIASES={}\n', {
    METADATA_TAG_ALIASES: aliases,
    PLAIN: 'no quoting needed',
    PATTERN: '^Q[1-4]\\s+\\d{4}$'
  });

  const parsed = dotenv.parse(after);
  assert.equal(parsed.METADATA_TAG_ALIASES, aliases);
  assert.deepEqual(JSON.parse(parsed.METADATA_TAG_ALIASES), { 'Unit #5': 'Maple Court', '1234 Oak Ave #2': 'Oak' });
  assert.equal(parsed.PLAIN, 'no quoting needed');
  assert.equal(parsed.PATTERN, '^Q[1-4]\\s+\\d{4}$');
  assert.match(after, /^PLAIN=no quoting needed$/m);
});

test('formatEnvValue refuses a value it cannot write unchanged', () => {
  assert.equal(formatEnvValue('plain'), 'plain');
  assert.equal(formatEnvValue('a #b'), "'a #b'");
  assert.equal(formatEnvValue("it's #1"), "`it's #1`");
  assert.throws(() => formatEnvValue("it's `#1`"));
});

test('a value wrapped in quote characters keeps them through dotenv', () => {
  const updates = {
    DOUBLE: '"Acme"',
    SINGLE: "'Acme'",
    BACKTICK: '`Acme`',
    INNER: 'say "Acme" twice',
    JSON_LIST: '["Bill","Invoice"]'
  };

  const after = updateEnvContent('FIRST=1\n', updates);

  assert.deepEqual(dotenv.parse(after), { FIRST: '1', ...updates });
  assert.match(after, /^INNER=say "Acme" twice$/m);
  assert.match(after, /^JSON_LIST=\["Bill","Invoice"\]$/m);
  assert.equal(updateEnvContent(after, updates), after);
});

test('buildEnvUpdates writes drop patterns with single escaping', () => {
  const updates = buildEnvUpdates({
    metadata: {
      dropPatterns: ['^Q[1-4]\\s+\\d{4}$'],
      customFieldDocumentTypes: { Amount: ['Bill'] }
    },
    paperlessAiEnv: { TAGS: 'paperless-ai-auto' }
  });

  assert.deepEqual(JSON.parse(updates.METADATA_TAG_DROP_PATTERNS), ['^Q[1-4]\\s+\\d{4}$']);
  assert.deepEqual(JSON.parse(updates.METADATA_CUSTOM_FIELD_DOCUMENT_TYPES), { Amount: ['Bill'] });
  assert.equal(updates.METADATA_TAG_ALIASES, '{}');
  assert.equal(updates.TAGS, 'paperless-ai-auto');
});
