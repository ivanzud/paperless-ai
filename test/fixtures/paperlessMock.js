'use strict';

const http = require('node:http');

const port = Number.parseInt(process.env.MOCK_PORT || '8080', 10);
const expectedToken = process.env.MOCK_TOKEN || 'mock-paperless-token';
const requestCounts = {};

const document = {
  id: 1,
  title: 'Initialization smoke document',
  content: 'This document proves the fresh RAG index was initialized.',
  correspondent: null,
  tags: [],
  created_date: '2026-07-31',
  created: '2026-07-31T00:00:00Z',
  modified: '2026-07-31T00:00:00Z'
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  requestCounts[url.pathname] = (requestCounts[url.pathname] || 0) + 1;

  if (url.pathname === '/mock/status') {
    return sendJson(response, 200, { requestCounts });
  }

  if (request.headers.authorization !== `Token ${expectedToken}`) {
    return sendJson(response, 401, { detail: 'Unauthorized' });
  }

  if (url.pathname === '/api/documents/') {
    return sendJson(response, 200, {
      count: 1,
      next: null,
      previous: null,
      results: [document]
    });
  }

  if (url.pathname === '/api/documents/1/') {
    return sendJson(response, 200, document);
  }

  if (url.pathname === '/api/documents/1/download/txt/') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end(document.content);
  }

  if (url.pathname === '/api/ui_settings/') {
    return sendJson(response, 200, {
      user: { id: 1, username: 'mock-user' }
    });
  }

  if (url.pathname === '/api/users/') {
    return sendJson(response, 200, {
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 1, username: 'mock-user' }]
    });
  }

  if (
    url.pathname === '/api/tags/'
    || url.pathname === '/api/correspondents/'
    || url.pathname === '/api/document_types/'
    || url.pathname === '/api/custom_fields/'
  ) {
    return sendJson(response, 200, {
      count: 0,
      next: null,
      previous: null,
      results: []
    });
  }

  return sendJson(response, 404, { detail: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Paperless mock listening on ${port}`);
});
