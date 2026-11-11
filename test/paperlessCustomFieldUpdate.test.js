'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { PaperlessService } = require('../services/paperlessService');

function createService({ currentDoc, fields, patch }) {
  const service = new PaperlessService();
  const patches = [];
  service.client = {
    async patch(url, payload) {
      patches.push(JSON.parse(JSON.stringify(payload)));
      return patch ? patch(payload, patches.length) : { data: {} };
    }
  };
  service.getDocument = async () => currentDoc;
  service.findExistingCustomFieldById = async (id) => fields[id] || null;
  return { service, patches };
}

function silenceConsole(t) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => Object.assign(console, original));
}

const FIELDS = {
  1: { id: 1, name: 'Amount', data_type: 'monetary' },
  2: { id: 2, name: 'Due Date', data_type: 'date' },
  3: { id: 3, name: 'Reference', data_type: 'string' }
};

test('updateDocument drops unusable custom field values and sends the rest', async (t) => {
  silenceConsole(t);
  const { service, patches } = createService({
    currentDoc: { id: 7, title: 'Scan', tags: [], correspondent: null, storage_path: null, custom_fields: [] },
    fields: FIELDS
  });

  await service.updateDocument(7, {
    title: 'Acme Invoice',
    custom_fields: [
      { field: 1, value: '0' },
      { field: 2, value: '01/13/26' },
      { field: 3, value: 'N/A' }
    ]
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].title, 'Acme Invoice');
  assert.deepEqual(patches[0].custom_fields, [{ field: 2, value: '2026-01-13' }]);
});

test('updateDocument never rewrites or deletes custom field values the document already has', async (t) => {
  silenceConsole(t);
  const { service, patches } = createService({
    currentDoc: {
      id: 7,
      title: 'Scan',
      tags: [],
      correspondent: null,
      storage_path: null,
      custom_fields: [
        { field: 1, value: 'USD0.00' },
        { field: 2, value: '2031-02-03' },
        { field: 9, value: ['opaque'] }
      ]
    },
    fields: FIELDS
  });

  await service.updateDocument(7, {
    title: 'Acme Invoice',
    custom_fields: [
      // New value for field 2 is garbage: the stored one has to stay.
      { field: 2, value: '21' },
      // Existing values travel along unchanged, whatever they look like.
      { field: 1, value: 'USD0.00' },
      { field: 9, value: ['opaque'] }
    ]
  });

  assert.deepEqual(patches[0].custom_fields, [
    { field: 2, value: '2031-02-03' },
    { field: 1, value: 'USD0.00' },
    { field: 9, value: ['opaque'] }
  ]);
});

function customFieldError(data) {
  const error = new Error('Request failed with status code 400');
  error.response = { status: 400, data };
  return error;
}

test('a custom field Paperless rejects is dropped and the remaining metadata is saved', async (t) => {
  silenceConsole(t);
  const { service, patches } = createService({
    currentDoc: { id: 7, title: 'Scan', tags: [], correspondent: null, storage_path: null, custom_fields: [] },
    fields: FIELDS,
    patch(payload, attempt) {
      if (attempt === 1) {
        throw customFieldError({ custom_fields: [{}, { value: ['Enter a valid value.'] }] });
      }
      return { data: {} };
    }
  });

  await service.updateDocument(7, {
    title: 'Acme Invoice',
    created: '2026-01-02',
    custom_fields: [
      { field: 1, value: '45.00' },
      { field: 3, value: 'REF-1234' }
    ]
  });

  assert.equal(patches.length, 2);
  assert.equal(patches[1].title, 'Acme Invoice');
  assert.equal(patches[1].created, '2026-01-02');
  assert.deepEqual(patches[1].custom_fields, [{ field: 1, value: '45.00' }]);
});

test('an unspecific custom field rejection keeps stored values and drops every new one', async (t) => {
  silenceConsole(t);
  const { service, patches } = createService({
    currentDoc: {
      id: 7,
      title: 'Scan',
      tags: [],
      correspondent: null,
      storage_path: null,
      custom_fields: [{ field: 3, value: 'REF-1234' }]
    },
    fields: FIELDS,
    patch(payload, attempt) {
      if (attempt === 1) {
        throw customFieldError({ custom_fields: ['Invalid data.'] });
      }
      return { data: {} };
    }
  });

  await service.updateDocument(7, {
    title: 'Acme Invoice',
    custom_fields: [
      { field: 1, value: '45.00' },
      { field: 3, value: 'REF-1234' }
    ]
  });

  assert.equal(patches.length, 2);
  assert.deepEqual(patches[1].custom_fields, [{ field: 3, value: 'REF-1234' }]);
});

test('a 400 that is not about custom fields still fails the update', async (t) => {
  silenceConsole(t);
  const failure = customFieldError({ title: ['This field may not be blank.'] });
  const { service, patches } = createService({
    currentDoc: { id: 7, title: 'Scan', tags: [], correspondent: null, storage_path: null, custom_fields: [] },
    fields: FIELDS,
    patch() {
      throw failure;
    }
  });

  await assert.rejects(
    service.updateDocument(7, { title: 'Acme Invoice', custom_fields: [{ field: 1, value: '45.00' }] }),
    (error) => error === failure
  );
  assert.equal(patches.length, 1);
});
