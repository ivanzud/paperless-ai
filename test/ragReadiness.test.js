'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const ragService = require('../services/ragService');

async function withReadinessServer(statusCode, body, callback) {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/ready');
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const originalBaseUrl = ragService.baseUrl;
  const address = server.address();
  ragService.baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback();
  } finally {
    ragService.baseUrl = originalBaseUrl;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('RAG readiness accepts a ready context service', async () => {
  await withReadinessServer(200, {
    status: 'ready',
    ready: true,
    checks: {
      models_initialized: true,
      search_engine_initialized: true,
      chroma_initialized: true,
      bm25_initialized: true
    }
  }, async () => {
    const readiness = await ragService.checkReadiness();
    assert.equal(readiness.ready, true);
  });
});

test('RAG readiness converts an upstream 503 into a constrained error', async () => {
  await withReadinessServer(503, {
    status: 'not_ready',
    ready: false
  }, async () => {
    await assert.rejects(
      ragService.checkReadiness(),
      (error) => {
        assert.equal(error.message, 'RAG service is not ready');
        assert.equal(error.code, 'RAG_NOT_READY');
        assert.equal(error.status, 503);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'status']);
        return true;
      }
    );
  });
});
