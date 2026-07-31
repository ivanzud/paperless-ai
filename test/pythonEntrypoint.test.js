'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.join(__dirname, '..');

function findProjectPython() {
  const candidates = [
    process.env.PAPERLESS_AI_PYTHON,
    path.join(repositoryRoot, 'venv', 'bin', 'python'),
    path.join(repositoryRoot, '.venv', 'bin', 'python')
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function runProjectPython(args, extraEnv = {}) {
  const python = findProjectPython();
  assert.ok(python, 'A synchronized Paperless-AI Python environment is required');

  return spawnSync(
    python,
    args,
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HF_HUB_DISABLE_XET: '1',
        NLTK_AUTO_DOWNLOAD: 'false',
        PYTHONPATH: repositoryRoot,
        ...extraEnv
      },
      encoding: 'utf8',
      timeout: 120000
    }
  );
}

test('CLI initialization handler is registered on the app passed to Uvicorn', () => {
  const result = runProjectPython([path.join(__dirname, 'python_cli_app_check.py')]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /cli-app-identity-ok/);
});

test('Python startup logs redact Paperless URL and token canaries', () => {
  const canaries = [
    'url-userinfo-canary',
    'url-password-canary',
    'query-token-canary',
    'ngx-user-canary',
    'ngx-password-canary',
    'host-query-canary',
    'paperless-api-token-canary',
    'paperless-token-canary',
    'paperless-apikey-canary'
  ];
  const result = runProjectPython(
    [
      '-c',
      'import main; main.DataManager(initialize_on_start=False); print("python-log-canary-ok")'
    ],
    {
      PAPERLESS_API_URL: 'https://url-userinfo-canary:url-password-canary@paperless-api.example:8443/base?token=query-token-canary',
      PAPERLESS_URL: 'https://url-userinfo-canary:url-password-canary@paperless-url.example/path?token=query-token-canary',
      PAPERLESS_NGX_URL: 'https://ngx-user-canary:ngx-password-canary@paperless-ngx.example/private',
      PAPERLESS_HOST: 'https://paperless-host.example/root?apiKey=host-query-canary',
      PAPERLESS_API_TOKEN: 'paperless-api-token-canary',
      PAPERLESS_TOKEN: 'paperless-token-canary',
      PAPERLESS_APIKEY: 'paperless-apikey-canary'
    }
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /python-log-canary-ok/);
  assert.match(output, /https:\/\/paperless-api\.example:8443/);
  for (const canary of canaries) {
    assert.equal(output.includes(canary), false, `Python log exposed ${canary}`);
  }
});
