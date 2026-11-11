'use strict';

const RestrictionPromptService = require('./restrictionPromptService');

// Pieces of the system prompt that the AI services share. Each of them used
// to be written out in every service, and each contradicted either the
// operator's own prompt or what happens to the answer afterwards.

// The settings page stores the prompt on one line with every line break
// written as the two characters backslash and n, and only the settings page
// turned them back. The model received one long line with "\n" sprinkled
// through it instead of the structure the operator wrote.
function readSystemPrompt(env = process.env) {
  return String(env.SYSTEM_PROMPT || '')
    .replace(/\\r\\n|\\n/g, '\n')
    .trim();
}

// With a closed list the names have to be copied as they are, whatever the
// language of the document is. Asking for them "in the language of the
// document" at the same time made the model translate or invent names that
// were then dropped.
function buildLanguageRule(restrictions = {}) {
  const translated = ['Title'];
  if (restrictions.restrictToExistingTags !== 'yes') {
    translated.unshift('Tags');
  }
  if (restrictions.restrictToExistingDocumentTypes !== 'yes') {
    translated.push('Document_Type');
  }

  if (translated.length === 1) {
    return 'The Title MUST be in the language that is used in the document.';
  }
  const last = translated.pop();
  return `The ${translated.join(', ')} and ${last} MUST be in the language that is used in the document.`;
}

// What to say about correspondents next to the JSON format.
//  - listAlreadyShown: the names are in the existing-data block at the top of
//    the prompt, so they are not repeated here (the list is often the largest
//    part of the prompt).
//  - With RESTRICT_TO_EXISTING_CORRESPONDENTS a new name is dropped later, so
//    the model is not invited to return one.
function buildCorrespondentInstruction(config = {}, existingCorrespondentList, { listAlreadyShown = false } = {}) {
  if (config.limitFunctions?.activateCorrespondents === 'no') {
    return '';
  }

  const names = RestrictionPromptService._formatCorrespondentsList(existingCorrespondentList);
  if (!names) {
    return '';
  }

  if (config.restrictToExistingCorrespondents === 'yes') {
    const rule = 'The correspondent must be one of the allowed correspondents, copied exactly. If none of them is the sender of the document, use an empty string for the correspondent.';
    return listAlreadyShown ? rule : `Allowed correspondents: ${names}\n${rule}`;
  }

  const rule = 'When identifying the correspondent, prefer a pre-existing one if the sender of the document is a close match and copy that name exactly (for example, return "Acme" if the document shows "Acme Holdings Inc." and "Acme" already exists). Only return a new name if none of the pre-existing correspondents is a reasonable match.';
  return listAlreadyShown
    ? rule
    : `IMPORTANT: The following correspondents already exist in the system: ${names}\n${rule}`;
}

// The text shown as the value of a custom field in the JSON format. A bare
// "fill in the value" made small models fill in something for every field (0,
// N/A, the date of the document); the hint names the expected format and says
// that an empty value is the right answer when the document has none.
function customFieldValueHint(field = {}) {
  const empty = 'or an empty string if the document does not state it';
  switch (String(field.data_type || field.dataType || '').toLowerCase()) {
    case 'monetary':
      return `number with . as decimal separator and without currency, ${empty}`;
    case 'date':
      return `date as YYYY-MM-DD, ${empty}`;
    case 'integer':
      return `whole number, ${empty}`;
    case 'float':
      return `number with . as decimal separator, ${empty}`;
    case 'boolean':
      return `true or false, ${empty}`;
    case 'url':
      return `complete URL, ${empty}`;
    default:
      return `value found in the document, ${empty}`;
  }
}

module.exports = {
  buildCorrespondentInstruction,
  buildLanguageRule,
  customFieldValueHint,
  readSystemPrompt
};
