"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PaperlessService } = require("../services/paperlessService");

const SECRET = "paperless-secret-sentinel-0123456789";

function createPatchError() {
  const error = new Error(`Authorization: Token ${SECRET}`);
  error.code = "ERR_BAD_REQUEST";
  error.response = {
    status: 400,
    data: { token: SECRET },
  };
  error.config = {
    headers: { Authorization: `Token ${SECRET}` },
  };
  return error;
}

async function captureErrors(callback) {
  const originalError = console.error;
  const captured = [];
  console.error = (...args) => captured.push(args);
  try {
    await callback();
  } finally {
    console.error = originalError;
  }
  return captured;
}

test("updateDocument propagates PATCH 400 and logs only a sanitized error", async () => {
  const service = new PaperlessService();
  const patchError = createPatchError();
  service.client = {
    async patch() {
      throw patchError;
    },
  };
  service.getDocument = async () => ({
    id: 42,
    title: "Original title",
    tags: [],
    correspondent: null,
    storage_path: null,
  });

  const captured = await captureErrors(async () => {
    await assert.rejects(
      service.updateDocument(42, { title: "Updated title" }),
      (error) => error === patchError,
    );
  });

  const output = JSON.stringify(captured);
  assert.equal(output.includes(SECRET), false);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /400/);
});

test("updateDocumentContent propagates PATCH 400 and logs only a sanitized error", async () => {
  const service = new PaperlessService();
  const patchError = createPatchError();
  service.client = {
    async patch() {
      throw patchError;
    },
  };

  const captured = await captureErrors(async () => {
    await assert.rejects(
      service.updateDocumentContent(42, "updated content"),
      (error) => error === patchError,
    );
  });

  const output = JSON.stringify(captured);
  assert.equal(output.includes(SECRET), false);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /400/);
});

test("document update helpers reject when Paperless is not configured", async () => {
  const service = new PaperlessService();

  await captureErrors(async () => {
    await assert.rejects(
      service.updateDocument(42, { title: "Updated title" }),
      (error) => error.code === "PAPERLESS_NOT_CONFIGURED",
    );
    await assert.rejects(
      service.updateDocumentContent(42, "updated content"),
      (error) => error.code === "PAPERLESS_NOT_CONFIGURED",
    );
    await assert.rejects(
      service.removeUnusedTagsFromDocument(42, []),
      (error) => error.code === "PAPERLESS_NOT_CONFIGURED",
    );
  });
});
