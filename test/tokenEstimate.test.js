'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  estimateTokensForNonOpenAI,
  truncateToEstimatedTokens,
  truncateToTokenLimit
} = require('../services/serviceUtils');

const PROSE = 'Dear Jane Doe, thank you for your recent payment. Your account with Acme Water Company remains in good standing. '.repeat(20);
const TABLE = Array.from(
  { length: 60 },
  (_, i) => `03/1${i % 9}/2025  POS PURCHASE EXAMPLE STORE #12${10 + i}  123.45  6789.01`
).join('\n');

test('a statement table is estimated at far more tokens than its length divided by four', () => {
  // Digits and punctuation are one token each for real tokenizers, so this
  // text is roughly 1.6 characters per token, not 4.
  const estimate = estimateTokensForNonOpenAI(TABLE);
  assert.ok(estimate > TABLE.length / 2, `${estimate} tokens for ${TABLE.length} characters`);
  assert.ok(estimate < TABLE.length);
});

test('prose stays close to one token per word', () => {
  const words = PROSE.trim().split(/\s+/).length;
  const estimate = estimateTokensForNonOpenAI(PROSE);
  assert.ok(estimate >= words, `${estimate} tokens for ${words} words`);
  assert.ok(estimate < words * 1.6, `${estimate} tokens for ${words} words`);
});

test('the estimate handles empty and non-string input', () => {
  assert.equal(estimateTokensForNonOpenAI(''), 0);
  assert.equal(estimateTokensForNonOpenAI(null), 0);
  assert.equal(estimateTokensForNonOpenAI('12345'), 5);
});

test('truncation keeps the longest prefix whose estimate fits', () => {
  const text = PROSE + TABLE + PROSE;
  assert.equal(truncateToEstimatedTokens(text, 100000), text);
  assert.equal(truncateToEstimatedTokens(text, 0), '');

  for (const limit of [50, 400, 900, 1500]) {
    const cut = truncateToEstimatedTokens(text, limit);
    const estimate = estimateTokensForNonOpenAI(cut);
    assert.ok(text.startsWith(cut));
    assert.ok(estimate <= limit, `${estimate} > ${limit}`);
    // Not needlessly short either: the dense middle part must not make the
    // prose in front of it shrink.
    assert.ok(estimate > limit * 0.8, `${estimate} is far below ${limit}`);
  }
});

test('truncateToTokenLimit uses the estimate for models without a tokenizer', async (t) => {
  const log = console.log;
  console.log = () => {};
  t.after(() => { console.log = log; });

  const cut = await truncateToTokenLimit(TABLE, 300, 'example/local-model');
  assert.ok(estimateTokensForNonOpenAI(cut) <= 300);
  // The old 4-characters-per-token cut would have kept 1200 characters here.
  assert.ok(cut.length < 700, `${cut.length} characters kept`);
});
