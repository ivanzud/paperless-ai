'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeExecutable(filename, contents) {
  fs.writeFileSync(filename, contents, { mode: 0o755 });
}

function createFakeRuntime() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-start-'));
  const binDir = path.join(appDir, 'bin');
  const venvBinDir = path.join(appDir, 'venv', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(venvBinDir, { recursive: true });
  fs.writeFileSync(path.join(venvBinDir, 'activate'), 'export VIRTUAL_ENV="${PAPERLESS_AI_APP_DIR}/venv"\n');
  fs.writeFileSync(path.join(appDir, 'main.py'), '');
  fs.writeFileSync(path.join(appDir, 'ecosystem.config.js'), '');

  writeExecutable(path.join(binDir, 'fake-python'), `#!/usr/bin/env bash
if [[ "\${FAKE_PYTHON_EXIT:-0}" == "1" ]]; then
  exit 0
fi
printf 'started\\n' > "$PAPERLESS_AI_APP_DIR/python.marker"
trap 'exit 0' TERM INT
while true; do sleep 0.05; done
`);

  writeExecutable(path.join(binDir, 'fake-pm2'), `#!/usr/bin/env bash
printf '%s\\n%s\\n' "$RAG_SERVICE_ENABLED" "$RAG_SERVICE_URL" > "$PAPERLESS_AI_APP_DIR/node.marker"
`);

  return { appDir, binDir };
}

function runStartup(extraEnv) {
  const runtime = createFakeRuntime();
  const result = spawnSync(
    'bash',
    [path.join(__dirname, '..', 'start-services.sh')],
    {
      cwd: runtime.appDir,
      env: {
        ...process.env,
        PAPERLESS_AI_APP_DIR: runtime.appDir,
        PYTHON_BIN: path.join(runtime.binDir, 'fake-python'),
        PM2_RUNTIME_BIN: path.join(runtime.binDir, 'fake-pm2'),
        RAG_STARTUP_DELAY_SECONDS: '0.05',
        ...extraEnv
      },
      encoding: 'utf8',
      timeout: 5000
    }
  );

  return { ...runtime, result };
}

test('RAG_SERVICE_ENABLED=false skips Python and preserves the caller URL', (t) => {
  const { appDir, result } = runStartup({
    RAG_SERVICE_ENABLED: 'false',
    RAG_SERVICE_URL: 'http://rag.example.test:9000'
  });
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(appDir, 'python.marker')), false);
  assert.equal(
    fs.readFileSync(path.join(appDir, 'node.marker'), 'utf8'),
    'false\nhttp://rag.example.test:9000\n'
  );
});

test('RAG defaults to enabled and starts Python with the local URL', (t) => {
  const { appDir, result } = runStartup({
    RAG_SERVICE_ENABLED: '',
    RAG_SERVICE_URL: ''
  });
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(appDir, 'python.marker'), 'utf8'), 'started\n');
  assert.equal(
    fs.readFileSync(path.join(appDir, 'node.marker'), 'utf8'),
    'true\nhttp://localhost:8000\n'
  );
});

test('a RAG process that exits during startup fails the container', (t) => {
  const { appDir, result } = runStartup({
    FAKE_PYTHON_EXIT: '1'
  });
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Python RAG service exited during startup/);
  assert.equal(fs.existsSync(path.join(appDir, 'node.marker')), false);
});
