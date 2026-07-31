'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const {
  REDACTED,
  redactSensitive,
  safeEndpoint,
  sanitizeText,
  toSafeError
} = require('../utils/logSanitizer');

const SENTINELS = {
  openaiKey: 'openai-secret-sentinel-0123456789',
  customApiKey: 'custom-secret-sentinel-0123456789',
  azureApiKey: 'azure-secret-sentinel-0123456789',
  geminiApiKey: 'gemini-secret-sentinel-0123456789',
  paperlessToken: 'paperless-secret-sentinel-0123456789',
  jwtSecret: 'jwt-secret-sentinel-0123456789'
};

test('redactSensitive recursively removes secret-bearing values', () => {
  const value = {
    openaiKey: SENTINELS.openaiKey,
    customApiKey: SENTINELS.customApiKey,
    nested: {
      azureApiKey: SENTINELS.azureApiKey,
      gemini_api_key: SENTINELS.geminiApiKey,
      paperlessToken: SENTINELS.paperlessToken,
      JWT_SECRET: SENTINELS.jwtSecret,
      authorization: `Bearer ${SENTINELS.customApiKey}`,
      cookie: `session=${SENTINELS.jwtSecret}`,
      model: 'gpt-4o-mini',
      monkey: 'not-sensitive'
    }
  };

  const redacted = redactSensitive(value);
  assert.equal(redacted.openaiKey, REDACTED);
  assert.equal(redacted.customApiKey, REDACTED);
  assert.equal(redacted.nested.azureApiKey, REDACTED);
  assert.equal(redacted.nested.gemini_api_key, REDACTED);
  assert.equal(redacted.nested.paperlessToken, REDACTED);
  assert.equal(redacted.nested.JWT_SECRET, REDACTED);
  assert.equal(redacted.nested.authorization, REDACTED);
  assert.equal(redacted.nested.cookie, REDACTED);
  assert.equal(redacted.nested.model, 'gpt-4o-mini');
  assert.equal(redacted.nested.monkey, 'not-sensitive');

  const serialized = JSON.stringify(redacted);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test('sanitizeText removes common inline credential forms', () => {
  const input = [
    `Authorization: Bearer ${SENTINELS.customApiKey}`,
    `openaiKey=${SENTINELS.openaiKey}`,
    `customApiKey=${SENTINELS.customApiKey}`,
    `https://user:${SENTINELS.jwtSecret}@example.test/path`,
    `https://example.test/path?token=${SENTINELS.paperlessToken}`
  ].join(' ');

  const sanitized = sanitizeText(input);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(sanitized.includes(sentinel), false);
  }
  assert.match(sanitized, /\[REDACTED\]/);
});

test('toSafeError omits request configuration and sanitizes its message', () => {
  const error = new Error(`customApiKey=${SENTINELS.customApiKey}`);
  error.status = 401;
  error.code = 'unauthorized';
  error.config = {
    headers: { Authorization: `Bearer ${SENTINELS.customApiKey}` }
  };

  const safeError = toSafeError(error);
  assert.deepEqual(Object.keys(safeError).sort(), ['code', 'message', 'name', 'status']);
  assert.equal(JSON.stringify(safeError).includes(SENTINELS.customApiKey), false);
});

test('safeEndpoint removes credentials, paths, queries, and fragments', () => {
  assert.equal(
    safeEndpoint(`https://user:${SENTINELS.customApiKey}@example.test/v1?token=x#fragment`),
    'https://example.test'
  );
  assert.equal(safeEndpoint('not a URL'), '[invalid endpoint]');
});

test('redactSensitive handles circular objects', () => {
  const value = { name: 'test' };
  value.self = value;
  assert.deepEqual(redactSensitive(value), { name: 'test', self: '[Circular]' });
});

test('custom provider validation never logs its API key', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers.authorization);
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      assert.doesNotThrow(() => JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }]
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);

  try {
    const setupService = require('../services/setupService');
    const address = server.address();
    const result = await setupService.validateCustomConfig(
      `http://127.0.0.1:${address.port}/v1`,
      SENTINELS.customApiKey,
      'test-model'
    );
    assert.equal(result, true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0], `Bearer ${SENTINELS.customApiKey}`);
  const serializedLogs = JSON.stringify(logs);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serializedLogs.includes(sentinel), false);
  }
});
