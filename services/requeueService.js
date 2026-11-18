'use strict';

// A document that was processed stays in the local list of processed
// documents until a scan no longer finds it in the queue. If it is put back
// into the queue before the next scan, that never happens, and the document
// would be skipped for good. The processed tag tells the two cases apart:
// processing adds it, so a queued document without it was queued again.

function createRequeueDetector({ documentModel, paperlessService, env = process.env }) {
  function processedTagName() {
    if (env.PROCESS_PREDEFINED_DOCUMENTS !== 'yes' || env.ADD_AI_PROCESSED_TAG !== 'yes') {
      return '';
    }
    return String(env.AI_PROCESSED_TAG_NAME || '').trim();
  }

  // True when the document is recorded as processed although it is in the
  // queue without the processed tag. Without a queue tag and a processed tag
  // there is nothing to compare, and the answer is always false.
  async function wasRequeued(doc) {
    try {
      const tagName = processedTagName();
      if (!tagName || !doc || !Array.isArray(doc.tags)) {
        return false;
      }

      const tag = await paperlessService.findExistingTag(tagName);
      if (!tag || doc.tags.includes(tag.id)) {
        return false;
      }

      return true;
    } catch (error) {
      console.warn(`[WARN] Could not check whether document ${doc?.id} was queued again: ${error.message}`);
      return false;
    }
  }

  // Resolves true when the document has to be left alone because it was
  // processed already.
  async function isProcessed(doc) {
    if (!await documentModel.isDocumentProcessed(doc.id, doc.checksum)) {
      return false;
    }
    if (!await wasRequeued(doc)) {
      return true;
    }

    console.log(`[INFO] Document ${doc.id} was queued again after it had been processed; processing it again.`);
    await documentModel.deleteDocumentsIdList([doc.id]);
    return false;
  }

  return { isProcessed, wasRequeued };
}

module.exports = { createRequeueDetector };
