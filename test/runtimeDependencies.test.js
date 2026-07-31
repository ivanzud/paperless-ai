'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const cron = require('node-cron');

test('EJS exposes the Express engine and compiles every view', () => {
  assert.equal(typeof ejs.__express, 'function');

  const viewsDir = path.join(__dirname, '..', 'views');
  const viewFiles = fs.readdirSync(viewsDir)
    .filter((file) => file.endsWith('.ejs'))
    .map((file) => path.join(viewsDir, file));

  assert.ok(viewFiles.length > 0);
  for (const filename of viewFiles) {
    const template = fs.readFileSync(filename, 'utf8');
    assert.doesNotThrow(
      () => ejs.compile(template, { filename }),
      `Expected ${path.basename(filename)} to compile`
    );
  }
});

test('node-cron accepts the configured five-field schedule format', () => {
  assert.equal(typeof cron.schedule, 'function');
  assert.equal(cron.validate('*/30 * * * *'), true);
  assert.equal(cron.validate('not a schedule'), false);
});
