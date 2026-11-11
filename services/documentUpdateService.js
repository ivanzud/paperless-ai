"use strict";

// Everything a processing run may overwrite in Paperless. Stored before the
// update so that a wrong title, date, type or amount can be put back by hand:
// the values are exactly what a PATCH to /api/documents/<id>/ accepts.
const SNAPSHOT_FIELDS = [
  "title",
  "created",
  "correspondent",
  "document_type",
  "storage_path",
  "tags",
  "custom_fields",
];

function buildPreviousValues(originalData = {}) {
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (originalData[field] !== undefined) {
      snapshot[field] = originalData[field];
    }
  }
  return snapshot;
}

async function saveAnalyzedDocumentChanges({
  documentModel,
  paperlessService,
  documentId,
  statusTitle,
  updateData,
  analysis,
  originalData,
  historyNotes = null,
}) {
  const {
    tags: originalTags,
    correspondent: originalCorrespondent,
    title: originalTitle,
  } = originalData;

  try {
    await documentModel.saveOriginalData(
      documentId,
      originalTags,
      originalCorrespondent,
      originalTitle,
      null,
      buildPreviousValues(originalData),
    );

    const updatedDocument = await paperlessService.updateDocument(
      documentId,
      updateData,
    );

    await Promise.all([
      documentModel.addProcessedDocument(
        documentId,
        updateData.title,
        originalData.checksum,
      ),
      documentModel.addOpenAIMetrics(
        documentId,
        analysis.metrics.promptTokens,
        analysis.metrics.completionTokens,
        analysis.metrics.totalTokens,
      ),
      documentModel.addToHistory(
        documentId,
        updateData.tags,
        updateData.title,
        analysis.document.correspondent,
        historyNotes,
      ),
    ]);

    await documentModel.setProcessingStatus(
      documentId,
      statusTitle,
      "complete",
    );
    // A success ends the run of failures that the retry limit counts.
    if (typeof documentModel.clearProcessingFailure === "function") {
      await documentModel.clearProcessingFailure(documentId);
    }
    return updatedDocument;
  } catch (error) {
    await documentModel.setProcessingStatus(documentId, statusTitle, "failed");
    throw error;
  }
}

async function saveManualDocumentChanges({
  documentModel,
  paperlessService,
  documentId,
  statusTitle,
  tagIds,
  updateData,
}) {
  await documentModel.setProcessingStatus(
    documentId,
    statusTitle,
    "processing",
  );

  try {
    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);
    const updatedDocument = await paperlessService.updateDocument(
      documentId,
      updateData,
    );
    await documentModel.addProcessedDocument(documentId, updateData.title);
    await documentModel.setProcessingStatus(
      documentId,
      statusTitle,
      "complete",
    );
    return updatedDocument;
  } catch (error) {
    await documentModel.setProcessingStatus(documentId, statusTitle, "failed");
    throw error;
  }
}

module.exports = {
  buildPreviousValues,
  saveAnalyzedDocumentChanges,
  saveManualDocumentChanges,
};
