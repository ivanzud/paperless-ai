'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// config.js reads data/.env under the working directory and the service
// writes its files relative to it, so run in an empty directory.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-custom-'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

Object.assign(process.env, {
  AI_PROVIDER: 'custom',
  CUSTOM_MODEL: 'example/local-model',
  CUSTOM_BASE_URL: 'http://192.0.2.10:8080/v1',
  CUSTOM_API_KEY: 'test',
  TOKEN_LIMIT: '3000',
  RESPONSE_TOKENS: '500',
  CUSTOM_FIELDS: '{"custom_fields":[]}',
  SYSTEM_PROMPT: 'Classify the document.'
});

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
const customService = require('../services/customService');
const paperlessService = require('../services/paperlessService');
const { estimateTokensForNonOpenAI } = require('../services/serviceUtils');
console.log = originalConsole.log;

const ANSWER = { title: 'Acme Invoice - March 2025', correspondent: 'Acme', tags: ['Invoice'], document_type: 'Invoice' };

function completion(content, finishReason = 'stop') {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
}

// Replace the OpenAI client with a function and silence the service's output.
function useBackend(t, handler) {
  const requests = [];
  const previous = {
    client: customService.client,
    rejected: customService.responseFormatRejected,
    thumbnail: paperlessService.getThumbnailImage
  };
  customService.client = {
    chat: { completions: { create: async (payload) => { requests.push({ ...payload }); return handler(payload, requests.length); } } }
  };
  customService.responseFormatRejected = false;
  customService._sleep = async () => {};
  paperlessService.getThumbnailImage = async () => Buffer.from('thumbnail');
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    Object.assign(console, originalConsole);
    customService.client = previous.client;
    customService.responseFormatRejected = previous.rejected;
    paperlessService.getThumbnailImage = previous.thumbnail;
  });
  return requests;
}

function withEnv(t, values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('the classification request limits the answer and asks for JSON', async (t) => {
  const requests = useBackend(t, () => completion(JSON.stringify(ANSWER)));

  const result = await customService._analyzeSingleChunk('system', 'document text', 'example/local-model', 'now', 500);

  assert.equal(requests[0].max_tokens, 500);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(result.document.title, ANSWER.title);
  assert.deepEqual(result.metrics, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test('the answer limit and the response format can be renamed or switched off', async (t) => {
  const requests = useBackend(t, () => completion(JSON.stringify(ANSWER)));

  withEnv(t, { CUSTOM_MAX_TOKENS_PARAM: 'max_completion_tokens', CUSTOM_RESPONSE_FORMAT: 'none' });
  await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);
  assert.equal(requests[0].max_completion_tokens, 500);
  assert.equal('max_tokens' in requests[0], false);
  assert.equal('response_format' in requests[0], false);

  process.env.CUSTOM_MAX_TOKENS_PARAM = 'none';
  await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);
  assert.equal('max_tokens' in requests[1], false);
  assert.equal('max_completion_tokens' in requests[1], false);
});

test('a backend without JSON mode is asked again without it, and not asked for it afterwards', async (t) => {
  const requests = useBackend(t, (payload) => {
    if (payload.response_format) {
      throw Object.assign(new Error('400 Unknown parameter: response_format'), { status: 400 });
    }
    return completion(JSON.stringify(ANSWER));
  });

  const first = await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);
  await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);

  assert.equal(first.document.title, ANSWER.title);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => 'response_format' in request), [true, false, false]);
  assert.equal(requests[1].max_tokens, 500);
});

test('other request errors are not mistaken for a missing JSON mode', async (t) => {
  const requests = useBackend(t, () => {
    throw Object.assign(new Error('500 backend unavailable'), { status: 500 });
  });

  await assert.rejects(
    customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500),
    /backend unavailable/
  );
  assert.equal(requests.length, 1);
  assert.equal(customService.responseFormatRejected, false);
});

test('a fenced JSON answer is accepted and text that is not JSON is reported as such', async (t) => {
  let content = '```json\n' + JSON.stringify(ANSWER) + '\n```';
  useBackend(t, () => completion(content));

  const result = await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);
  assert.deepEqual(result.document.tags, ['Invoice']);

  content = 'I could not read this document.';
  await assert.rejects(
    customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500),
    /Invalid JSON response from API/
  );
});

test('an answer cut off at the token limit is reported as cut off, not as invalid JSON', async (t) => {
  useBackend(t, () => completion('{"title": "Acme Invoice - March 2025", "tags": ["Inv', 'length'));

  await assert.rejects(
    customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500),
    /cut off at the response token limit/
  );
});

test('a response log that cannot be written does not fail the document', async (t) => {
  useBackend(t, () => completion(JSON.stringify(ANSWER)));
  // Make ./logs a file so that nothing can be written below it.
  fs.rmSync(path.join(workDir, 'logs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(workDir, 'logs'), 'not a directory');
  t.after(() => fs.rmSync(path.join(workDir, 'logs'), { force: true }));
  withEnv(t, { LOG_LEVEL: 'debug' });

  const result = await customService._analyzeSingleChunk('system', 'text', 'example/local-model', 'now', 500);
  assert.equal(result.document.title, ANSWER.title);
});
