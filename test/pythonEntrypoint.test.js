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

test('Python logs recursively redact structured and serialized secrets', () => {
  const secretCanaries = [
    'json-quoted-secret-canary',
    'repr-dict-secret-canary',
    'repr-string-secret-canary',
    'nested-secret-canary',
    'tuple-secret-canary',
    'args-mapping-secret-canary',
    'args-json-secret-canary',
    'args-positional-secret-canary',
    'prefixed-json-secret-canary',
    'double-json-secret-canary',
    'prefixed-double-json-secret-canary',
    'escaped-json-suffix-secret-canary',
    'url-comma-suffix-secret-canary',
    'url-semicolon-suffix-secret-canary',
    'ipv6-path-secret-canary',
    'ipv6-query-secret-canary',
    'bearer-comma-suffix-secret-canary',
    'bearer-semicolon-suffix-secret-canary',
    'token-delimiter-suffix-secret-canary',
    'basic-auth-secret-canary',
    'proxy-auth-secret-canary',
    'digest-auth-secret-canary',
    'aws4-auth-secret-canary',
    'cookie-first-secret-canary',
    'cookie-second-secret-canary',
    'namespace-basic-secret-canary',
    'namespace-digest-secret-canary',
    'namespace-cookie-secret-canary',
    'folded-auth-secret-canary',
    'folded-cookie-secret-canary',
    'policy-auth-secret-canary',
    'policy-cookie-secret-canary',
    'assignment-comma-suffix-secret-canary',
    'assignment-semicolon-suffix-secret-canary',
    'malformed-url-secret-canary',
    'postgres-uri-secret-canary',
    'mysql-uri-secret-canary',
    'redis-uri-secret-canary',
    'amqp-uri-secret-canary',
    'encoded-key-secret-canary',
    'signature-map-secret-canary',
    'amz-signature-map-secret-canary',
    'auth-map-secret-canary',
    'authentication-map-secret-canary',
    'unicode-repr-secret-canary',
    'idempotent-secret-canary',
    'whitespace-password-secret-canary',
    'whitespace-secret-secret-canary',
    'whitespace-credential-secret-canary',
    'whitespace-authorization-secret-canary',
    'cycle-secret-canary',
    'deep-secret-canary',
    'late-item-secret-canary',
    'long-text-secret-canary',
    'long-double-json-secret-canary',
    'exception-secret-canary',
    'stack-secret-canary',
    'stack-text-secret-canary',
    'fail-closed-secret-canary'
  ];
  const safeMarkers = [
    'json-safe-marker',
    'repr-safe-marker',
    'repr-string-safe-marker',
    'nested-safe-marker',
    'tuple-safe-marker',
    'args-mapping-safe-marker',
    'args-json-safe-marker',
    'mapping-format-safe-marker',
    'args-positional-safe-marker',
    'prefixed-safe-marker',
    'double-json-safe-marker',
    'prefixed-double-json-safe-marker',
    'escaped-json-safe-marker',
    'url-delimiter-safe-marker',
    'ipv6-safe-marker',
    'bearer-safe-marker',
    'token-safe-marker',
    'basic-auth-safe-marker',
    'proxy-auth-safe-marker',
    'digest-auth-safe-marker',
    'aws4-auth-safe-marker',
    'cookie-safe-marker',
    'namespace-basic-safe-marker',
    'namespace-digest-safe-marker',
    'namespace-cookie-safe-marker',
    'folded-auth-safe-marker',
    'folded-cookie-safe-marker',
    'explicit-policy-auth-safe-marker',
    'explicit-policy-cookie-safe-marker',
    'assignment-safe-marker',
    'malformed-url-safe-marker',
    'postgres-uri-safe-marker',
    'mysql-uri-safe-marker',
    'redis-uri-safe-marker',
    'amqp-uri-safe-marker',
    'encoded-key-safe-marker',
    'encoded-json-safe-marker',
    'structured-auth-safe-marker',
    'unicode-repr-safe-marker',
    'unicode-repr-inner-safe-marker',
    'idempotent-pass-safe-marker',
    'idempotent-safe-marker',
    'ordinary-marker-one',
    'ordinary-marker-two',
    'ordinary-marker-three',
    'ordinary-marker-four',
    'cycle-safe-marker',
    'deep-safe-marker',
    'item-bound-safe-marker',
    'long-text-safe-marker',
    'long-double-json-pass-safe-marker',
    'exception-log-safe-marker',
    'exception-detail-safe-marker',
    'stack-safe-marker',
    'stack-record-safe-marker',
    'stack-detail-safe-marker'
  ];
  const result = runProjectPython([
    path.join(__dirname, 'python_log_sanitizer_check.py')
  ]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /python-structured-log-canary-ok/);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /\[TRUNCATED\]/);
  assert.match(output, /\[log sanitization failed\]/);
  assert.match(output, /\[invalid endpoint\]/);
  assert.match(output, /http:\/\/\[2001:db8::1\]:8443/);
  assert.match(output, /postgresql:\/\/db\.example/);
  assert.match(output, /mysql:\/\/db\.example/);
  assert.match(output, /redis:\/\/cache\.example/);
  assert.match(output, /amqp:\/\/mq\.example/);
  assert.match(output, /safe-state-marker PAPERLESS_API_TOKEN: \[NOT SET\]/);
  assert.match(output, /safe-set-marker PAPERLESS_API_TOKEN: \[SET\]/);
  assert.match(output, /safe-prose-marker password policy remains enforced/);
  assert.match(
    output,
    /header-prose-a-safe-marker authorization policy remains enforced/
  );
  assert.match(output, /header-prose-c-safe-marker cookie policy remains enforced/);
  for (const canary of secretCanaries) {
    assert.equal(output.includes(canary), false, `Python log exposed ${canary}`);
  }
  for (const marker of safeMarkers) {
    assert.equal(output.includes(marker), true, `Python log lost ${marker}`);
  }
});

test('Python logger filter covers root and future third-party handlers', () => {
  const secrets = [
    'preconfigured-root-secret-canary',
    'hf-signature-secret-canary',
    'late-handler-secret-canary',
    'uvicorn-access-secret-canary',
    'preconfigured-extra-secret-canary',
    'preconfigured-extra-url-canary',
    'preconfigured-nested-secret-canary',
    'preconfigured-cycle-secret-canary',
    'late-filter-extra-secret-canary',
    'late-filter-url-secret-canary',
    'late-filter-nested-secret-canary',
    'make-record-message-secret-canary',
    'make-record-extra-secret-canary',
    'make-record-url-secret-canary',
    'make-record-path-secret-canary',
    'make-record-nested-secret-canary',
    'direct-record-message-secret-canary',
    'direct-record-extra-secret-canary',
    'direct-record-url-secret-canary',
    'direct-record-nested-secret-canary',
    'fail-closed-extra-secret-canary',
    'preexisting-override-message-secret-canary',
    'preexisting-override-extra-secret-canary',
    'future-override-message-secret-canary',
    'future-override-extra-secret-canary',
    'preexisting-override-filter-message-secret-canary',
    'preexisting-override-filter-extra-secret-canary',
    'future-override-filter-message-secret-canary',
    'future-override-filter-extra-secret-canary',
    'malformed-key-secret-canary',
    'remote-process-secret-canary',
    'remote-thread-secret-canary',
    'core-process-bytes-secret-canary',
    'core-thread-map-secret-canary',
    'core-line-list-secret-canary',
    'core-created-object-secret-canary',
    'core-level-secret-canary',
    'reload-hook-secret-canary',
    '123456'
  ];
  const result = runProjectPython([
    path.join(__dirname, 'python_preconfigured_logging_check.py')
  ]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /python-preconfigured-log-canary-ok/);
  assert.match(output, /preconfigured-safe-marker/);
  assert.match(output, /third-party-httpx-safe-marker/);
  assert.match(output, /late-handler-safe-marker/);
  assert.match(output, /preconfigured-extra-safe-marker/);
  assert.match(output, /preconfigured-nested-safe-marker/);
  assert.match(output, /late-filter-nested-safe-marker/);
  assert.match(output, /make-record-safe-marker/);
  assert.match(output, /make-record-nested-safe-marker/);
  assert.match(output, /direct-record-safe-marker/);
  assert.match(output, /direct-record-nested-safe-marker/);
  assert.match(output, /preexisting-override-safe-marker/);
  assert.match(output, /future-override-safe-marker/);
  assert.match(output, /preexisting-override-filter-safe-marker/);
  assert.match(output, /future-override-filter-safe-marker/);
  assert.match(output, /remote-core-safe-marker/);
  assert.match(
    output,
    /opaque-core-safe-marker process=0 thread=0 line=0 created=0\.0/
  );
  assert.match(output, /malformed-level-safe-marker level=0/);
  assert.match(output, /numeric-sensitive-safe-marker key=0/);
  assert.match(output, /reload-safe-marker/);
  assert.match(output, /\[log sanitization failed\]/);
  for (const safeNumber of [42, 84, 126, 168, 210]) {
    assert.match(output, new RegExp(`number=${safeNumber}`));
  }
  assert.match(output, /GET \/private HTTP\/1\.1/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(result.stderr, /--- Logging error ---/);
  assert.doesNotMatch(result.stderr, /not enough values to unpack/);
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false);
  }
});
