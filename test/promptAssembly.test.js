'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// config.js reads data/.env under the working directory and the service
// writes its files relative to it, so run in an empty directory.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ai-prompt-'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

// A restricted setup: closed lists, the prompt stored the way the settings
// page writes it (one line, line breaks as backslash + n).
Object.assign(process.env, {
  AI_PROVIDER: 'custom',
  CUSTOM_MODEL: 'example/local-model',
  CUSTOM_BASE_URL: 'http://192.0.2.10:8080/v1',
  CUSTOM_API_KEY: 'test',
  TOKEN_LIMIT: '6000',
  RESPONSE_TOKENS: '500',
  USE_EXISTING_DATA: 'yes',
  RESTRICT_TO_EXISTING_TAGS: 'yes',
  RESTRICT_TO_EXISTING_CORRESPONDENTS: 'yes',
  RESTRICT_TO_EXISTING_DOCUMENT_TYPES: 'yes',
  CUSTOM_FIELDS: JSON.stringify({
    custom_fields: [
      { value: 'Amount', data_type: 'monetary', currency: 'USD' },
      { value: 'Due Date', data_type: 'date' },
      { value: 'Reference', data_type: 'string' }
    ]
  }),
  SYSTEM_PROMPT: 'You label documents.\\n\\nTITLE RULES\\n- Keep titles short.\\n- Name the person.\n'
});

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
const config = require('../config/config');
const customService = require('../services/customService');
const paperlessService = require('../services/paperlessService');
const {
  buildCorrespondentInstruction,
  buildLanguageRule,
  customFieldValueHint,
  readSystemPrompt
} = require('../services/promptAssembly');
console.log = originalConsole.log;

const CORRESPONDENTS = ['Acme', 'Example Bank', 'City Utilities'];
const ANSWER = { title: 'Acme Invoice - March 2025', correspondent: 'Acme', tags: ['Invoice'], document_type: 'Invoice' };

// Runs one analysis against a fake backend and returns the system prompt sent.
async function systemPromptFor(t, { customPrompt = null } = {}) {
  const requests = [];
  const previous = { client: customService.client, thumbnail: paperlessService.getThumbnailImage };
  customService.client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          return {
            choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          };
        }
      }
    }
  };
  paperlessService.getThumbnailImage = async () => null;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    Object.assign(console, originalConsole);
    customService.client = previous.client;
    paperlessService.getThumbnailImage = previous.thumbnail;
  });

  await customService.analyzeDocument(
    'Invoice 1234 from Acme, total 45.00, due 2025-04-01.',
    ['Invoice', 'Jane Doe'],
    CORRESPONDENTS,
    ['Invoice', 'Letter'],
    4243,
    customPrompt
  );
  assert.equal(requests.length, 1);
  return requests[0].messages[0].content;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('the stored system prompt reaches the model with real line breaks', async (t) => {
  assert.equal(readSystemPrompt(), 'You label documents.\n\nTITLE RULES\n- Keep titles short.\n- Name the person.');
  assert.equal(readSystemPrompt({ SYSTEM_PROMPT: 'one\\r\\ntwo\\nthree' }), 'one\ntwo\nthree');
  assert.equal(readSystemPrompt({ SYSTEM_PROMPT: 'already\nmultiline' }), 'already\nmultiline');
  assert.equal(readSystemPrompt({}), '');

  const prompt = await systemPromptFor(t);
  assert.match(prompt, /You label documents\.\n\nTITLE RULES\n- Keep titles short\.\n- Name the person\.\n/);
  assert.doesNotMatch(prompt, /\\n/);
});

test('a restricted prompt lists the correspondents once and does not ask for new names', async (t) => {
  const prompt = await systemPromptFor(t);

  assert.match(prompt, /Allowed existing correspondents \(copy exact names only\): Acme, Example Bank, City Utilities/);
  for (const name of CORRESPONDENTS) {
    assert.equal(count(prompt, name), 1, name);
  }
  assert.match(prompt, /If none of them is the sender of the document, use an empty string/);
  assert.doesNotMatch(prompt, /new name/i);
  assert.doesNotMatch(prompt, /%EXISTING_CORRESPONDENTS%|%CUSTOMFIELDS%/);
});

test('closed tag and document type lists are not asked for in the language of the document', async (t) => {
  const prompt = await systemPromptFor(t);

  assert.match(prompt, /The Title MUST be in the language that is used in the document\./);
  assert.doesNotMatch(prompt, /Tags, Title and Document_Type MUST/);
  assert.match(config.mustHavePrompt, /Return the result EXCLUSIVELY as a JSON object\. The Title MUST/);

  assert.equal(
    buildLanguageRule({}),
    'The Tags, Title and Document_Type MUST be in the language that is used in the document.'
  );
  assert.equal(
    buildLanguageRule({ restrictToExistingTags: 'yes' }),
    'The Title and Document_Type MUST be in the language that is used in the document.'
  );
  assert.equal(
    buildLanguageRule({ restrictToExistingDocumentTypes: 'yes' }),
    'The Tags and Title MUST be in the language that is used in the document.'
  );
});

test('custom fields are described by format and may stay empty', async (t) => {
  const prompt = await systemPromptFor(t);

  assert.doesNotMatch(prompt, /Fill in the value based on your analysis/);
  assert.match(prompt, /"field_name": "Amount",\s+"value": "number with \. as decimal separator and without currency, or an empty string if the document does not state it"/);
  assert.match(prompt, /"field_name": "Due Date",\s+"value": "date as YYYY-MM-DD, or an empty string if the document does not state it"/);
  assert.match(prompt, /"field_name": "Reference",\s+"value": "value found in the document, or an empty string if the document does not state it"/);

  assert.match(customFieldValueHint({ data_type: 'integer' }), /^whole number, or an empty string/);
  assert.match(customFieldValueHint({ dataType: 'Boolean' }), /^true or false, or an empty string/);
  assert.match(customFieldValueHint(), /^value found in the document, or an empty string/);
});

test('a custom prompt still gets the list of allowed correspondents', async (t) => {
  const prompt = await systemPromptFor(t, { customPrompt: 'Only look at the first page.' });

  assert.match(prompt, /^Only look at the first page\./);
  assert.match(prompt, /Allowed correspondents: Acme, Example Bank, City Utilities\n/);
  for (const name of CORRESPONDENTS) {
    assert.equal(count(prompt, name), 1, name);
  }
});

test('the correspondent instruction follows the restriction and the switches', () => {
  const open = { restrictToExistingCorrespondents: 'no' };

  const listed = buildCorrespondentInstruction(open, CORRESPONDENTS);
  assert.match(listed, /^IMPORTANT: The following correspondents already exist in the system: Acme, Example Bank, City Utilities\n/);
  assert.match(listed, /Only return a new name if none of the pre-existing correspondents is a reasonable match\./);

  const afterBlock = buildCorrespondentInstruction(open, CORRESPONDENTS, { listAlreadyShown: true });
  assert.doesNotMatch(afterBlock, /Example Bank/);
  assert.match(afterBlock, /prefer a pre-existing one/);

  // Names can arrive as objects or as one string.
  assert.match(
    buildCorrespondentInstruction({ restrictToExistingCorrespondents: 'yes' }, [{ name: 'Acme' }, { name: 'Example Bank' }]),
    /^Allowed correspondents: Acme, Example Bank\nThe correspondent must be one of the allowed correspondents/
  );
  assert.match(buildCorrespondentInstruction(open, 'Acme, Example Bank'), /system: Acme, Example Bank\n/);

  assert.equal(buildCorrespondentInstruction(open, []), '');
  assert.equal(buildCorrespondentInstruction(open, null), '');
  assert.equal(
    buildCorrespondentInstruction({ limitFunctions: { activateCorrespondents: 'no' } }, CORRESPONDENTS),
    ''
  );
});
