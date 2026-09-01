"use strict";

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
  saveAnalyzedDocumentChanges,
  saveManualDocumentChanges,
};
