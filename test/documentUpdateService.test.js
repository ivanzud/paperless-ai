"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  saveAnalyzedDocumentChanges,
  saveManualDocumentChanges,
} = require("../services/documentUpdateService");

function createFixture(overrides = {}) {
  const calls = [];
  const updatedDocument = { id: 42, title: "Updated title" };
  const documentModel = {
    async saveOriginalData(...args) {
      calls.push(["saveOriginalData", ...args]);
      return true;
    },
    async addProcessedDocument(...args) {
      calls.push(["addProcessedDocument", ...args]);
      return true;
    },
    async addOpenAIMetrics(...args) {
      calls.push(["addOpenAIMetrics", ...args]);
      return true;
    },
    async addToHistory(...args) {
      calls.push(["addToHistory", ...args]);
      return true;
    },
    async setProcessingStatus(...args) {
      calls.push(["setProcessingStatus", ...args]);
      return true;
    },
    ...overrides.documentModel,
  };
  const paperlessService = {
    async updateDocument(...args) {
      calls.push(["updateDocument", ...args]);
      return updatedDocument;
    },
    ...overrides.paperlessService,
  };

  return {
    calls,
    documentModel,
    paperlessService,
    updatedDocument,
    input: {
      documentModel,
      paperlessService,
      documentId: 42,
      statusTitle: "Original title",
      updateData: {
        title: "Updated title",
        tags: [3, 7],
      },
      analysis: {
        document: { correspondent: "Example Corp" },
        metrics: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      },
      originalData: {
        title: "Original title",
        tags: [3],
        correspondent: 8,
        checksum: "checksum-42",
      },
      historyNotes: "AI note",
    },
  };
}

test("a rejected Paperless PATCH leaves the document failed and retryable", async () => {
  const patchError = new Error("Request failed with status code 400");
  patchError.response = { status: 400 };
  const fixture = createFixture({
    paperlessService: {
      async updateDocument(...args) {
        fixture.calls.push(["updateDocument", ...args]);
        throw patchError;
      },
    },
  });

  await assert.rejects(
    saveAnalyzedDocumentChanges(fixture.input),
    (error) => error === patchError,
  );

  assert.deepEqual(
    fixture.calls.map(([name]) => name),
    ["saveOriginalData", "updateDocument", "setProcessingStatus"],
  );
  assert.deepEqual(fixture.calls.at(-1), [
    "setProcessingStatus",
    42,
    "Original title",
    "failed",
  ]);
  assert.equal(
    fixture.calls.some(([name]) =>
      ["addProcessedDocument", "addOpenAIMetrics", "addToHistory"].includes(
        name,
      ),
    ),
    false,
  );
  assert.equal(
    fixture.calls.some(
      (call) => call[0] === "setProcessingStatus" && call[3] === "complete",
    ),
    false,
  );
});

test("successful Paperless PATCH precedes bookkeeping and completion", async () => {
  const fixture = createFixture();

  const result = await saveAnalyzedDocumentChanges(fixture.input);

  assert.equal(result, fixture.updatedDocument);
  assert.deepEqual(
    fixture.calls.map(([name]) => name),
    [
      "saveOriginalData",
      "updateDocument",
      "addProcessedDocument",
      "addOpenAIMetrics",
      "addToHistory",
      "setProcessingStatus",
    ],
  );
  assert.deepEqual(fixture.calls.at(-1), [
    "setProcessingStatus",
    42,
    "Original title",
    "complete",
  ]);
});

test("manual update PATCH rejection records failure without a processed row", async () => {
  const calls = [];
  const patchError = new Error("Request failed with status code 400");
  patchError.response = { status: 400 };
  const documentModel = {
    async setProcessingStatus(...args) {
      calls.push(["setProcessingStatus", ...args]);
      return true;
    },
    async addProcessedDocument(...args) {
      calls.push(["addProcessedDocument", ...args]);
      return true;
    },
  };
  const paperlessService = {
    async removeUnusedTagsFromDocument(...args) {
      calls.push(["removeUnusedTagsFromDocument", ...args]);
    },
    async updateDocument(...args) {
      calls.push(["updateDocument", ...args]);
      throw patchError;
    },
  };

  await assert.rejects(
    saveManualDocumentChanges({
      documentModel,
      paperlessService,
      documentId: 42,
      statusTitle: "Updated title",
      tagIds: [3, 7],
      updateData: { title: "Updated title", tags: [3, 7] },
    }),
    (error) => error === patchError,
  );

  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "setProcessingStatus",
      "removeUnusedTagsFromDocument",
      "updateDocument",
      "setProcessingStatus",
    ],
  );
  assert.deepEqual(calls.at(-1), [
    "setProcessingStatus",
    42,
    "Updated title",
    "failed",
  ]);
  assert.equal(
    calls.some(([name]) => name === "addProcessedDocument"),
    false,
  );
});

test("successful manual update records processed state after both PATCH operations", async () => {
  const calls = [];
  const updatedDocument = { id: 42, title: "Updated title" };
  const documentModel = {
    async setProcessingStatus(...args) {
      calls.push(["setProcessingStatus", ...args]);
      return true;
    },
    async addProcessedDocument(...args) {
      calls.push(["addProcessedDocument", ...args]);
      return true;
    },
  };
  const paperlessService = {
    async removeUnusedTagsFromDocument(...args) {
      calls.push(["removeUnusedTagsFromDocument", ...args]);
    },
    async updateDocument(...args) {
      calls.push(["updateDocument", ...args]);
      return updatedDocument;
    },
  };

  const result = await saveManualDocumentChanges({
    documentModel,
    paperlessService,
    documentId: 42,
    statusTitle: "Updated title",
    tagIds: [3, 7],
    updateData: { title: "Updated title", tags: [3, 7] },
  });

  assert.equal(result, updatedDocument);
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "setProcessingStatus",
      "removeUnusedTagsFromDocument",
      "updateDocument",
      "addProcessedDocument",
      "setProcessingStatus",
    ],
  );
  assert.deepEqual(calls.at(-1), [
    "setProcessingStatus",
    42,
    "Updated title",
    "complete",
  ]);
});
