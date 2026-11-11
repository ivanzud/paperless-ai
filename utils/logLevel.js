'use strict';

// Console output is filtered by LOG_LEVEL (debug, info, warn, error). The
// default is info: lines marked [DEBUG] and console.debug are dropped, and
// the files that keep full prompts and model responses are not written.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ALIASES = { verbose: 'debug', trace: 'debug', warning: 'warn' };
const DEFAULT_LEVEL = 'info';

function getLogLevel(env = process.env) {
  const value = String(env.LOG_LEVEL || '').trim().toLowerCase();
  const level = ALIASES[value] || value;
  return LEVELS[level] ? level : DEFAULT_LEVEL;
}

function isDebugEnabled(env = process.env) {
  return getLogLevel(env) === 'debug';
}

// The code base marks its debug output with a [DEBUG] prefix on console.log.
function getMessageLevel(method, args) {
  if (method === 'error' || method === 'warn' || method === 'debug') {
    return method;
  }
  const first = args && args.length ? args[0] : undefined;
  if (typeof first === 'string' && /^\s*\[DEBUG\]/i.test(first)) {
    return 'debug';
  }
  return 'info';
}

function shouldLog(method, args, env = process.env) {
  return LEVELS[getMessageLevel(method, args)] >= LEVELS[getLogLevel(env)];
}

module.exports = {
  getLogLevel,
  getMessageLevel,
  isDebugEnabled,
  shouldLog
};
