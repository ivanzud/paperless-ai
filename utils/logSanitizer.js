'use strict';

const REDACTED = '[REDACTED]';

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized.endsWith('key')) {
    return true;
  }

  return [
    'token',
    'secret',
    'password',
    'passwd',
    'authorization',
    'cookie',
    'credential',
    'privatekey'
  ].some((term) => normalized.includes(term));
}

function sanitizeText(value) {
  const text = String(value);
  const trimmed = text.trim();

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(redactSensitive(parsed));
      }
    } catch {
      // Fall through to best-effort text redaction for malformed JSON.
    }
  }

  return text
    .replace(/\b(Bearer|Token)\s+[^\s,;}]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:["']?(?:[a-z0-9_-]*key|[a-z0-9_-]*(?:token|secret|password|authorization|cookie))["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /([?&](?:[a-z0-9_-]*key|[a-z0-9_-]*(?:token|secret|password))=)[^&\s]*/gi,
      '$1[REDACTED]'
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
}

function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeText(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return toSafeError(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactSensitive(item, seen)
    ])
  );
}

function toSafeError(error) {
  if (!error) {
    return { message: 'Unknown error' };
  }

  if (typeof error === 'string') {
    return { message: sanitizeText(error) };
  }

  const safeError = {
    name: sanitizeText(error.name || 'Error'),
    message: sanitizeText(error.message || 'Unknown error')
  };

  const status = error.status || error.response?.status || error.error?.status;
  if (status !== undefined) {
    safeError.status = status;
  }

  if (error.code !== undefined) {
    safeError.code = sanitizeText(error.code);
  }

  return safeError;
}

function safeEndpoint(value) {
  try {
    const endpoint = new URL(value);
    return endpoint.origin;
  } catch {
    return '[invalid endpoint]';
  }
}

function sanitizeLogArguments(args) {
  return Array.from(args, (argument) => redactSensitive(argument));
}

const SAFE_CONSOLE_MARKER = Symbol.for('paperless-ai.safe-console');

function installSafeConsole(target = console) {
  if (target[SAFE_CONSOLE_MARKER]) {
    return () => {};
  }

  const originals = {};
  for (const level of ['log', 'error', 'warn', 'info', 'debug']) {
    if (typeof target[level] !== 'function') {
      continue;
    }
    originals[level] = target[level];
    target[level] = (...args) => originals[level].apply(target, sanitizeLogArguments(args));
  }

  Object.defineProperty(target, SAFE_CONSOLE_MARKER, {
    configurable: true,
    value: true
  });

  return () => {
    for (const [level, original] of Object.entries(originals)) {
      target[level] = original;
    }
    delete target[SAFE_CONSOLE_MARKER];
  };
}

module.exports = {
  REDACTED,
  installSafeConsole,
  isSensitiveKey,
  redactSensitive,
  safeEndpoint,
  sanitizeLogArguments,
  sanitizeText,
  toSafeError
};
