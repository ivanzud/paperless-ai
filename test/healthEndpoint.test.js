'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// The router opens data/documents.db below the working directory on load.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-health-'));
const previousCwd = process.cwd();
process.chdir(workDir);
const originalLog = console.log;
console.log = () => {};
const express = require('express');
const cookieParser = require('cookie-parser');
const setupService = require('../services/setupService');
const router = require('../routes/setup');
console.log = originalLog;

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('/health tells a configured service that cannot reach its backends from a working one', async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use('/', router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const previous = setupService.configured;
  t.after(() => {
    setupService.configured = previous;
    server.close();
    process.chdir(previousCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  setupService.configured = null;
  const waiting = await get(server, '/health');
  assert.equal(waiting.status, 503);
  assert.equal(waiting.body.status, 'waiting_for_backends');

  setupService.configured = true;
  const ready = await get(server, '/health');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'healthy');

  // A fresh install waiting for the setup page is reachable and healthy.
  setupService.configured = false;
  const fresh = await get(server, '/health');
  assert.equal(fresh.status, 200);
});
