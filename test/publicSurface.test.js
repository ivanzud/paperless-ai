'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// The router opens data/documents.db below the working directory on load.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-surface-'));
const previousCwd = process.cwd();
process.chdir(workDir);
process.env.API_KEY = 'test-api-key';
const originalLog = console.log;
console.log = () => {};
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const setupService = require('../services/setupService');
const paperlessService = require('../services/paperlessService');
const router = require('../routes/setup');
const { buildCorsOptions, registerStaticAndDocs } = require('../routes/publicSurface');
const {
  ensureThumbnailCached,
  getThumbnailCacheDir,
  getThumbnailCachePath
} = require('../services/thumbnailCache');
console.log = originalLog;

const publicDir = path.join(workDir, 'public');
fs.mkdirSync(path.join(publicDir, 'css'), { recursive: true });
fs.mkdirSync(path.join(publicDir, 'images'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'css', 'login.css'), 'body { margin: 0; }');
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), 'icon');
// A thumbnail left behind by a version that cached below public/.
fs.writeFileSync(path.join(publicDir, 'images', '7.png'), 'legacy thumbnail');

const API_KEY = { 'x-api-key': 'test-api-key' };

function request(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

let server;

test.before(async () => {
  const app = express();
  app.use(cors(buildCorsOptions({})));
  registerStaticAndDocs(app, { publicDir, swaggerSpec: { openapi: '3.0.0', info: { title: 'test', version: '1' }, paths: {} } });
  app.use('/', router);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
});

test.after(() => {
  server.close();
  process.chdir(previousCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

function quiet(t) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => Object.assign(console, saved));
}

test('the login page assets and the health endpoint need no login', async (t) => {
  quiet(t);
  const previous = setupService.configured;
  setupService.configured = true;
  t.after(() => { setupService.configured = previous; });

  const css = await request(server, '/css/login.css');
  assert.equal(css.status, 200);
  assert.equal(css.body, 'body { margin: 0; }');
  assert.equal((await request(server, '/favicon.ico')).status, 200);
  assert.equal((await request(server, '/health')).status, 200);
});

test('files below /images are not handed out without a login', async () => {
  const anonymous = await request(server, '/images/7.png');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, '/login');
  assert.doesNotMatch(anonymous.body, /legacy thumbnail/);

  const withKey = await request(server, '/images/7.png', API_KEY);
  assert.equal(withKey.status, 200);
  assert.equal(withKey.body, 'legacy thumbnail');

  const cookie = `jwt=${jwt.sign({ id: 1, username: 'jane' }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
  assert.equal((await request(server, '/images/7.png', { cookie })).status, 200);
  assert.equal((await request(server, '/images/7.png', { cookie: 'jwt=not-a-token' })).status, 302);
  assert.equal((await request(server, '/images/7.png', { 'x-api-key': 'wrong' })).status, 302);
});

test('the API documentation requires a login', async (t) => {
  quiet(t);
  for (const urlPath of ['/api-docs/openapi.json', '/api-docs.json', '/api-docs/', '/api-docs/swagger-ui.css']) {
    const anonymous = await request(server, urlPath);
    assert.equal(anonymous.status, 302, urlPath);
    assert.equal(anonymous.headers.location, '/login', urlPath);
  }

  const spec = await request(server, '/api-docs/openapi.json', API_KEY);
  assert.equal(spec.status, 200);
  assert.equal(JSON.parse(spec.body).openapi, '3.0.0');
  assert.equal((await request(server, '/api-docs.json', API_KEY)).status, 200);
  assert.equal((await request(server, '/api-docs/', API_KEY)).status, 200);
});

test('other origins get no access unless they are configured', async () => {
  const foreign = await request(server, '/css/login.css', { origin: 'https://other.example.com' });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  assert.equal(foreign.headers['access-control-allow-private-network'], undefined);

  assert.equal(buildCorsOptions({}).origin, false);
  assert.equal(buildCorsOptions({ CORS_ALLOWED_ORIGINS: ' , ' }).origin, false);
  assert.deepEqual(
    buildCorsOptions({ CORS_ALLOWED_ORIGINS: 'https://app.example.com/, http://192.0.2.10:8080' }).origin,
    ['https://app.example.com', 'http://192.0.2.10:8080']
  );
  assert.equal(buildCorsOptions({ CORS_ALLOWED_ORIGINS: 'https://app.example.com' }).credentials, false);
});

test('thumbnails are cached outside the public directory and served only after login', async (t) => {
  quiet(t);
  const previous = setupService.configured;
  const originalFetch = paperlessService.getThumbnailImage;
  const fetched = [];
  setupService.configured = true;
  paperlessService.getThumbnailImage = async (documentId) => {
    fetched.push(String(documentId));
    return String(documentId) === '404' ? null : Buffer.from(`thumbnail of ${documentId}`);
  };
  t.after(() => {
    setupService.configured = previous;
    paperlessService.getThumbnailImage = originalFetch;
  });

  const anonymous = await request(server, '/thumb/12');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, '/login');
  assert.deepEqual(fetched, []);

  const first = await request(server, '/thumb/12', API_KEY);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  assert.equal(first.body, 'thumbnail of 12');

  // The second request is answered from the cache.
  const second = await request(server, '/thumb/12', API_KEY);
  assert.equal(second.body, 'thumbnail of 12');
  assert.deepEqual(fetched, ['12']);

  assert.equal(fs.readFileSync(path.join(workDir, 'data', 'thumb-cache', '12.png'), 'utf8'), 'thumbnail of 12');
  assert.deepEqual(fs.readdirSync(path.join(publicDir, 'images')), ['7.png']);
  assert.equal(fs.existsSync(path.join(workDir, 'public', 'images', '12.png')), false);
  assert.equal((await request(server, '/images/12.png', API_KEY)).status, 404);

  assert.equal((await request(server, '/thumb/404', API_KEY)).status, 404);

  // The id ends up in a file name: only plain numbers are accepted.
  for (const id of ['..%2F..%2Fdata%2Fdocuments', '12.png', '1e3', '-12', '12abc']) {
    const rejected = await request(server, `/thumb/${id}`, API_KEY);
    assert.equal(rejected.status, 400, id);
  }
  assert.deepEqual(fetched, ['12', '404']);
});

test('caching a thumbnail never fails the caller', async (t) => {
  quiet(t);
  assert.equal(getThumbnailCacheDir(), path.join(process.cwd(), 'data', 'thumb-cache'));
  assert.equal(getThumbnailCachePath('../../etc/passwd'), null);
  assert.equal(getThumbnailCachePath(undefined), null);
  assert.equal(getThumbnailCachePath(''), null);
  assert.equal(getThumbnailCachePath(31), path.join(getThumbnailCacheDir(), '31.png'));

  assert.equal(await ensureThumbnailCached('../31', async () => Buffer.from('x')), null);
  assert.equal(await ensureThumbnailCached(31, async () => null), null);
  assert.equal(await ensureThumbnailCached(31, async () => { throw new Error('Paperless is away'); }), null);
  assert.equal(fs.existsSync(getThumbnailCachePath(31)), false);

  assert.equal(await ensureThumbnailCached(31, async () => Buffer.from('page one')), getThumbnailCachePath(31));
  // A cached thumbnail is not fetched again.
  assert.equal(
    await ensureThumbnailCached(31, async () => { throw new Error('must not be called'); }),
    getThumbnailCachePath(31)
  );
});
