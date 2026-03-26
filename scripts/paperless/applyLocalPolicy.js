#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CONTAINER = 'paperless-ai';
const DEFAULT_CONTAINER_ENV_PATH = '/app/data/.env';
const DEFAULT_POLICY_PATH = path.resolve(__dirname, '../../config/local/paperless-policy.local.json');

function parseArgs(argv) {
  const options = {
    container: DEFAULT_CONTAINER,
    containerEnvPath: DEFAULT_CONTAINER_ENV_PATH,
    dryRun: false,
    skipEnv: false,
    skipWorkflows: false,
    cleanupCompleted: true,
    restartContainer: true,
    policyPath: DEFAULT_POLICY_PATH,
    envFile: null,
    paperlessUrl: process.env.PAPERLESS_API_URL || '',
    paperlessToken: process.env.PAPERLESS_API_TOKEN || ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
    case '--container':
      options.container = next;
      index += 1;
      break;
    case '--env-path':
      options.containerEnvPath = next;
      index += 1;
      break;
    case '--env-file':
      options.envFile = path.resolve(next);
      index += 1;
      break;
    case '--policy':
      options.policyPath = path.resolve(next);
      index += 1;
      break;
    case '--paperless-url':
      options.paperlessUrl = next;
      index += 1;
      break;
    case '--paperless-token':
      options.paperlessToken = next;
      index += 1;
      break;
    case '--dry-run':
      options.dryRun = true;
      break;
    case '--skip-env':
      options.skipEnv = true;
      break;
    case '--skip-workflows':
      options.skipWorkflows = true;
      break;
    case '--skip-cleanup':
      options.cleanupCompleted = false;
      break;
    case '--no-restart':
      options.restartContainer = false;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;
    default:
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/paperless/applyLocalPolicy.js [options]

Options:
  --container <name>        Docker container name to read/update runtime env from
  --env-path <path>         Runtime env file path inside the container (default: ${DEFAULT_CONTAINER_ENV_PATH})
  --env-file <path>         Host-side env file to read/update instead of docker exec
  --policy <path>           Local policy JSON path (default: ${DEFAULT_POLICY_PATH})
  --paperless-url <url>     Override Paperless API URL
  --paperless-token <token> Override Paperless API token
  --dry-run                 Show planned changes without applying them
  --skip-env                Skip metadata env patching
  --skip-workflows          Skip tag/workflow reconciliation
  --skip-cleanup            Skip cleanup of already-completed pipeline tags
  --no-restart              Do not restart the paperless-ai container after env changes
  --help, -h                Show this help
`);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: options.input,
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  const stdout = result.stdout || '';
  return options.preserveTrailingNewline ? stdout : stdout.trimEnd();
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function readJson(filePath) {
  if (!fileExists(filePath)) {
    throw new Error(`Policy file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseEnv(rawText) {
  const env = {};
  for (const line of rawText.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (key) {
      env[key] = value;
    }
  }

  return env;
}

function updateEnvContent(rawText, updates) {
  const lines = rawText.split(/\r?\n/);
  const pendingKeys = new Set(Object.keys(updates));
  const output = [];

  for (const line of lines) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex !== -1) {
      const key = line.slice(0, separatorIndex).trim();
      if (pendingKeys.has(key)) {
        output.push(`${key}=${updates[key]}`);
        pendingKeys.delete(key);
        continue;
      }
    }

    output.push(line);
  }

  for (const key of Object.keys(updates)) {
    if (pendingKeys.has(key)) {
      output.push(`${key}=${updates[key]}`);
    }
  }

  return `${output.filter((line, index, values) => !(index === values.length - 1 && line === '')).join('\n')}\n`;
}

function loadRuntimeEnv(options) {
  if (options.paperlessUrl && options.paperlessToken) {
    return {
      PAPERLESS_API_URL: options.paperlessUrl,
      PAPERLESS_API_TOKEN: options.paperlessToken
    };
  }

  if (options.envFile) {
    return parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  }

  if (options.container) {
    return parseEnv(runCommand('docker', ['exec', options.container, 'cat', options.containerEnvPath]));
  }

  throw new Error('Unable to resolve Paperless credentials. Provide --paperless-url/--paperless-token, --env-file, or --container.');
}

function buildEnvUpdates(policy) {
  return {
    METADATA_TAG_ALIASES: JSON.stringify(policy.metadata.tagAliases || {}),
    METADATA_TITLE_REPLACEMENTS: JSON.stringify(policy.metadata.titleReplacements || {}),
    METADATA_PROPERTY_TAGS: (policy.metadata.propertyTags || []).join(','),
    METADATA_DROP_ADDRESS_TAGS: policy.metadata.dropAddressTags ? 'yes' : 'no',
    METADATA_TAG_DROP_EXACT: JSON.stringify(policy.metadata.dropExactTags || []),
    METADATA_TAG_DROP_PATTERNS: JSON.stringify(policy.metadata.dropPatterns || []),
    METADATA_KEEP_NUMERIC_TAGS: JSON.stringify(policy.metadata.keepNumericTags || []),
    ...(policy.paperlessAiEnv || {})
  };
}

function patchLocalEnvFile(envFile, updates, dryRun) {
  const current = fileExists(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const updated = updateEnvContent(current, updates);

  if (dryRun) {
    return { changed: current !== updated, target: envFile };
  }

  fs.writeFileSync(envFile, updated);
  return { changed: current !== updated, target: envFile };
}

function patchContainerEnv(container, envPath, updates, dryRun) {
  const current = runCommand('docker', ['exec', container, 'cat', envPath], { preserveTrailingNewline: true });
  const updated = updateEnvContent(current, updates);

  if (dryRun) {
    return { changed: current !== updated, target: `${container}:${envPath}` };
  }

  const pythonScript = `
from pathlib import Path

env_path = Path(${JSON.stringify(envPath)})
env_path.write_text(${JSON.stringify(updated)})
print(env_path)
`.trimStart();

  runCommand('docker', ['exec', '-i', container, 'python3', '-'], { input: pythonScript });
  return { changed: current !== updated, target: `${container}:${envPath}` };
}

function normalizeApiBaseUrl(apiUrl) {
  return apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
}

async function apiRequest(apiUrl, token, method, resourcePath, body) {
  const baseUrl = normalizeApiBaseUrl(apiUrl);
  const url = resourcePath.startsWith('http')
    ? resourcePath
    : new URL(resourcePath.replace(/^\//, ''), baseUrl).toString();

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${url} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function listResults(apiUrl, token, resourcePath) {
  let next = `${resourcePath}${resourcePath.includes('?') ? '&' : '?'}page_size=200`;
  const results = [];

  while (next) {
    const data = await apiRequest(apiUrl, token, 'GET', next);
    if (Array.isArray(data)) {
      results.push(...data);
      break;
    }

    results.push(...(data.results || []));
    next = data.next || null;
  }

  return results;
}

async function ensureTags(apiUrl, token, policy, dryRun) {
  const canonicalMetadataTags = new Set([
    ...(policy.metadata.propertyTags || []),
    ...Object.values(policy.metadata.tagAliases || {})
  ].filter(Boolean));

  const pipelineTagNames = Object.values(policy.pipeline.tags || {}).filter(Boolean);
  const requiredTagNames = [...new Set([...pipelineTagNames, ...canonicalMetadataTags])];
  const existingTags = await listResults(apiUrl, token, 'tags/');
  const tagMap = new Map(existingTags.map((tag) => [tag.name, tag]));
  const created = [];

  for (const tagName of requiredTagNames) {
    if (tagMap.has(tagName)) {
      continue;
    }

    created.push(tagName);
    if (dryRun) {
      continue;
    }

    const createdTag = await apiRequest(apiUrl, token, 'POST', 'tags/', {
      name: tagName,
      matching_algorithm: 0,
      is_insensitive: true
    });
    tagMap.set(createdTag.name, createdTag);
  }

  return { tagMap, created };
}

function resolveTagIds(names, tagMap) {
  return (names || []).map((name) => {
    const tag = tagMap.get(name);
    if (!tag) {
      throw new Error(`Required Paperless tag is missing: ${name}`);
    }
    return tag.id;
  });
}

function buildTrigger(trigger, tagMap, existingTrigger = {}) {
  return {
    ...existingTrigger,
    sources: trigger.sources || [1, 2, 3, 4],
    type: trigger.type,
    filter_path: null,
    filter_filename: null,
    filter_mailrule: null,
    matching_algorithm: 0,
    match: '',
    is_insensitive: true,
    filter_has_tags: [],
    filter_has_all_tags: resolveTagIds(trigger.allTags, tagMap),
    filter_has_not_tags: resolveTagIds(trigger.notTags, tagMap),
    filter_custom_field_query: null,
    filter_has_not_correspondents: [],
    filter_has_not_document_types: [],
    filter_has_not_storage_paths: [],
    filter_has_correspondent: null,
    filter_has_document_type: null,
    filter_has_storage_path: null,
    schedule_offset_days: 0,
    schedule_is_recurring: false,
    schedule_recurring_interval_days: 1,
    schedule_date_field: 'added',
    schedule_date_custom_field: null
  };
}

function buildAction(action, tagMap, existingAction = {}) {
  return {
    ...existingAction,
    type: action.type,
    assign_title: null,
    assign_tags: resolveTagIds(action.assignTags, tagMap),
    assign_correspondent: null,
    assign_document_type: null,
    assign_storage_path: null,
    assign_owner: null,
    assign_view_users: [],
    assign_view_groups: [],
    assign_change_users: [],
    assign_change_groups: [],
    assign_custom_fields: [],
    assign_custom_fields_values: {},
    remove_all_tags: false,
    remove_tags: resolveTagIds(action.removeTags, tagMap),
    remove_all_correspondents: false,
    remove_correspondents: [],
    remove_all_document_types: false,
    remove_document_types: [],
    remove_all_storage_paths: false,
    remove_storage_paths: [],
    remove_custom_fields: [],
    remove_all_custom_fields: false,
    remove_all_owners: false,
    remove_owners: [],
    remove_all_permissions: false,
    remove_view_users: [],
    remove_view_groups: [],
    remove_change_users: [],
    remove_change_groups: [],
    email: null,
    webhook: null
  };
}

function buildWorkflowPayload(spec, tagMap, existingWorkflow = null) {
  const existingTriggers = existingWorkflow?.triggers || [];
  const existingActions = existingWorkflow?.actions || [];

  return {
    ...(existingWorkflow || {}),
    name: spec.name,
    order: spec.order,
    enabled: spec.enabled !== false,
    triggers: (spec.triggers || []).map((trigger, index) => buildTrigger(trigger, tagMap, existingTriggers[index])),
    actions: (spec.actions || []).map((action, index) => buildAction(action, tagMap, existingActions[index]))
  };
}

function summarizeWorkflow(workflow) {
  return JSON.stringify({
    name: workflow.name,
    order: workflow.order,
    enabled: workflow.enabled,
    triggers: workflow.triggers.map((trigger) => ({
      type: trigger.type,
      sources: trigger.sources,
      filter_has_all_tags: trigger.filter_has_all_tags,
      filter_has_not_tags: trigger.filter_has_not_tags
    })),
    actions: workflow.actions.map((action) => ({
      type: action.type,
      assign_tags: action.assign_tags,
      remove_tags: action.remove_tags
    }))
  });
}

async function ensureWorkflows(apiUrl, token, policy, tagMap, dryRun) {
  const existingWorkflows = await listResults(apiUrl, token, 'workflows/');
  const workflowMap = new Map(existingWorkflows.map((workflow) => [workflow.name, workflow]));
  const changes = [];

  for (const spec of policy.pipeline.workflows || []) {
    const existingWorkflow = workflowMap.get(spec.name) || null;
    const desiredPayload = buildWorkflowPayload(spec, tagMap, existingWorkflow);
    const currentSummary = existingWorkflow ? summarizeWorkflow(existingWorkflow) : null;
    const desiredSummary = summarizeWorkflow(desiredPayload);

    if (currentSummary === desiredSummary) {
      continue;
    }

    changes.push({ name: spec.name, mode: existingWorkflow ? 'update' : 'create' });
    if (dryRun) {
      continue;
    }

    if (existingWorkflow) {
      await apiRequest(apiUrl, token, 'PUT', `workflows/${existingWorkflow.id}/`, desiredPayload);
    } else {
      const createPayload = buildWorkflowPayload(spec, tagMap, null);
      await apiRequest(apiUrl, token, 'POST', 'workflows/', createPayload);
    }
  }

  return changes;
}

async function cleanupCompletedDocuments(apiUrl, token, policy, tagMap, dryRun) {
  const aiProcessedId = tagMap.get(policy.pipeline.tags.aiProcessed)?.id;
  const gptOcrCompleteId = tagMap.get(policy.pipeline.tags.paperlessGptOcrComplete)?.id;
  const cleanupIds = resolveTagIds([
    policy.pipeline.tags.aiProcessed,
    policy.pipeline.tags.paperlessAiAuto,
    policy.pipeline.tags.paperlessGptOcrComplete
  ], tagMap);

  if (!aiProcessedId || !gptOcrCompleteId) {
    return [];
  }

  const documents = await listResults(apiUrl, token, 'documents/');
  const changedDocuments = [];

  for (const document of documents) {
    const currentTags = document.tags || [];
    if (!currentTags.includes(aiProcessedId) || !currentTags.includes(gptOcrCompleteId)) {
      continue;
    }

    const nextTags = currentTags.filter((tagId) => !cleanupIds.includes(tagId));
    changedDocuments.push({ id: document.id, title: document.title, tagsBefore: currentTags, tagsAfter: nextTags });

    if (!dryRun) {
      await apiRequest(apiUrl, token, 'PATCH', `documents/${document.id}/`, { tags: nextTags });
    }
  }

  return changedDocuments;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = readJson(options.policyPath);
  const runtimeEnv = loadRuntimeEnv(options);
  const paperlessUrl = options.paperlessUrl || runtimeEnv.PAPERLESS_API_URL;
  const paperlessToken = options.paperlessToken || runtimeEnv.PAPERLESS_API_TOKEN;

  if (!paperlessUrl || !paperlessToken) {
    throw new Error('PAPERLESS_API_URL and PAPERLESS_API_TOKEN are required.');
  }

  const summary = {
    policyPath: options.policyPath,
    envTarget: null,
    envChanged: false,
    createdTags: [],
    workflowChanges: [],
    cleanedDocuments: [],
    restartedContainer: false,
    dryRun: options.dryRun
  };

  if (!options.skipEnv) {
    const envUpdates = buildEnvUpdates(policy);
    const envResult = options.envFile
      ? patchLocalEnvFile(options.envFile, envUpdates, options.dryRun)
      : patchContainerEnv(options.container, options.containerEnvPath, envUpdates, options.dryRun);

    summary.envTarget = envResult.target;
    summary.envChanged = envResult.changed;
  }

  if (!options.skipWorkflows) {
    const { tagMap, created } = await ensureTags(paperlessUrl, paperlessToken, policy, options.dryRun);
    summary.createdTags = created;
    summary.workflowChanges = await ensureWorkflows(paperlessUrl, paperlessToken, policy, tagMap, options.dryRun);

    if (options.cleanupCompleted) {
      summary.cleanedDocuments = await cleanupCompletedDocuments(paperlessUrl, paperlessToken, policy, tagMap, options.dryRun);
    }
  }

  if (!options.dryRun && !options.skipEnv && options.container && options.restartContainer && summary.envChanged) {
    runCommand('docker', ['restart', options.container]);
    summary.restartedContainer = true;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
