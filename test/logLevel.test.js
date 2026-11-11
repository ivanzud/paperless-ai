'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const Logger = require('../services/loggerService');
const { installSafeConsole } = require('../utils/logSanitizer');
const { getLogLevel, isDebugEnabled, shouldLog } = require('../utils/logLevel');
const { writePromptToFile, writeResponseToFile } = require('../services/serviceUtils');

function withLogLevel(t, value) {
  const previous = process.env.LOG_LEVEL;
  if (value === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous;
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-loglevel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the log level defaults to info and only LOG_LEVEL changes it', () => {
  assert.equal(getLogLevel({}), 'info');
  assert.equal(getLogLevel({ LOG_LEVEL: '' }), 'info');
  assert.equal(getLogLevel({ LOG_LEVEL: 'nonsense' }), 'info');
  assert.equal(getLogLevel({ LOG_LEVEL: ' DEBUG ' }), 'debug');
  assert.equal(getLogLevel({ LOG_LEVEL: 'warning' }), 'warn');
  assert.equal(isDebugEnabled({}), false);
  assert.equal(isDebugEnabled({ LOG_LEVEL: 'debug' }), true);
});

test('debug lines are dropped unless the debug level is set', () => {
  const info = {};
  assert.equal(shouldLog('log', ['[DEBUG] Fetched page 1'], info), false);
  assert.equal(shouldLog('debug', ['details'], info), false);
  assert.equal(shouldLog('log', ['[INFO] Task completed'], info), true);
  assert.equal(shouldLog('log', ['Server running on port 3000'], info), true);
  assert.equal(shouldLog('info', [{ any: 'object' }], info), true);
  assert.equal(shouldLog('warn', ['[WARNING] slow'], info), true);
  assert.equal(shouldLog('error', ['[DEBUG] still an error'], info), true);

  const debug = { LOG_LEVEL: 'debug' };
  assert.equal(shouldLog('log', ['[DEBUG] Fetched page 1'], debug), true);
  assert.equal(shouldLog('debug', ['details'], debug), true);

  const warn = { LOG_LEVEL: 'warn' };
  assert.equal(shouldLog('log', ['[INFO] Task completed'], warn), false);
  assert.equal(shouldLog('warn', ['[WARNING] slow'], warn), true);
  assert.equal(shouldLog('error', ['failed'], { LOG_LEVEL: 'error' }), true);
  assert.equal(shouldLog('warn', ['[WARNING] slow'], { LOG_LEVEL: 'error' }), false);
});

test('the console and the log file leave out debug lines at the default level', (t) => {
  withLogLevel(t, undefined);
  const logDir = tempDir(t);
  const original = {
    log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug
  };
  const printed = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => printed.push(args.join(' '));
  }
  const restoreSafeConsole = installSafeConsole();
  const logger = new Logger({ logFile: 'test.log', logDir, format: 'txt', timestamp: false });
  t.after(() => {
    logger.restore();
    restoreSafeConsole();
    Object.assign(console, original);
  });

  console.log('[DEBUG] Response from AI service:', { title: 'Acme Invoice - March 2025' });
  console.debug('document text of Jane Doe');
  console.log('[INFO] Document 12 analyzed (150 tokens)');
  console.warn('[WARNING] something to look at');

  process.env.LOG_LEVEL = 'debug';
  console.log('[DEBUG] shown when asked for');

  const file = fs.readFileSync(path.join(logDir, 'test.log'), 'utf8');
  for (const output of [printed.join('\n'), file]) {
    assert.equal(output.includes('Acme Invoice'), false);
    assert.equal(output.includes('Jane Doe'), false);
    assert.ok(output.includes('Document 12 analyzed'));
    assert.ok(output.includes('something to look at'));
    assert.ok(output.includes('shown when asked for'));
  }
});

test('prompts and responses are only kept on disk at the debug level', async (t) => {
  const dir = tempDir(t);
  const promptFile = path.join(dir, 'logs', 'prompt.txt');
  const responseFile = path.join(dir, 'logs', 'response.txt');

  withLogLevel(t, undefined);
  assert.equal(await writePromptToFile('system prompt', 'text of the document', promptFile), false);
  assert.equal(await writeResponseToFile({ title: 'Acme Invoice' }, responseFile), false);
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false);

  process.env.LOG_LEVEL = 'debug';
  assert.equal(await writePromptToFile('system prompt', 'text of the document', promptFile), true);
  assert.equal(await writeResponseToFile({ title: 'Acme Invoice' }, responseFile), true);
  assert.equal(await writeResponseToFile('{"title":"Second"}', responseFile), true);
  assert.match(fs.readFileSync(promptFile, 'utf8'), /SYSTEM PROMPT:\nsystem prompt\n\nUSER CONTENT:\ntext of the document/);
  assert.equal(fs.readFileSync(responseFile, 'utf8'), '{"title":"Acme Invoice"}\n{"title":"Second"}\n');
});

test('a debug file starts over at its size limit and never fails the caller', async (t) => {
  const dir = tempDir(t);
  const responseFile = path.join(dir, 'response.txt');
  withLogLevel(t, 'debug');

  const entry = 'x'.repeat(40);
  for (let i = 0; i < 10; i += 1) {
    await writeResponseToFile(entry, responseFile, 100);
    assert.ok(fs.statSync(responseFile).size <= 100);
  }
  assert.equal(fs.readFileSync(responseFile, 'utf8'), `${entry}\n`.repeat(2));

  // A directory that cannot be created: warn, do not throw.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = warn; });
  assert.equal(await writeResponseToFile(entry, path.join(blocker, 'response.txt')), false);
  assert.equal(warnings.length, 1);
});
