'use strict';

// A document that cannot be processed used to stay in the queue and was tried
// again on every scan, forever and without any sign of it in Paperless. This
// keeps a per-document failure count, stops after a few attempts and marks
// the document with a tag so that it can be found and looked at.
//
//   MAX_PROCESSING_ATTEMPTS  attempts before giving up (default 3, 0 = never give up)
//   AI_FAILED_TAG_NAME       tag put on a given-up document (default paperless-ai-failed)
//
// Removing that tag from the document asks for another round of attempts.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_FAILED_TAG_NAME = 'paperless-ai-failed';

function getMaxAttempts(env = process.env) {
  const raw = String(env.MAX_PROCESSING_ATTEMPTS ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_ATTEMPTS;
}

function getFailedTagName(env = process.env) {
  return String(env.AI_FAILED_TAG_NAME || '').trim() || DEFAULT_FAILED_TAG_NAME;
}

// An unreachable or overloaded backend says nothing about the document. Such
// failures are not counted: an outage must not mark the whole queue as failed.
function isBackendUnavailable(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || error.response?.status || error.error?.status);
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
    return true;
  }

  const code = String(error.code || error.cause?.code || '').toUpperCase();
  if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE'].includes(code)) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return /econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|socket hang up|connection error|request timed out|timeout of \d+ms|rate limit|too many requests|service unavailable|bad gateway|gateway timeout/.test(message)
    || /(^|: )(401|403|408|429|5\d\d)\b/.test(message);
}

function describeError(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
}

function createFailedDocumentTracker({ documentModel, paperlessService, env = process.env }) {
  async function tagAsFailed(documentId) {
    const tagName = getFailedTagName(env);
    const tag = (await paperlessService.findExistingTag(tagName))
      || (await paperlessService.createTagSafely(tagName));
    const current = await paperlessService.getDocument(documentId);
    const tags = Array.isArray(current?.tags) ? current.tags : [];
    if (!tags.includes(tag.id)) {
      // Only adds the marker. The queue tag stays, so nothing else that
      // watches the document's tags sees it leave and re-enter the queue.
      await paperlessService.patchDocumentMetadata(documentId, { tags: [...tags, tag.id] }, current);
    }
    await documentModel.markProcessingFailureTagged(documentId);
  }

  async function tryTagAsFailed(documentId) {
    try {
      await tagAsFailed(documentId);
      return true;
    } catch (error) {
      console.warn(`[WARN] Could not tag document ${documentId} as failed; trying again at the next scan:`, describeError(error));
      return false;
    }
  }

  // True when the document was given up on and must not be processed again.
  async function shouldSkip(doc) {
    try {
      const maxAttempts = getMaxAttempts(env);
      if (maxAttempts === 0 || !doc) {
        return false;
      }

      const failure = await documentModel.getProcessingFailure(doc.id);
      if (!failure || failure.attempts < maxAttempts) {
        return false;
      }

      if (!failure.tagged) {
        await tryTagAsFailed(doc.id);
        return true;
      }

      if (Array.isArray(doc.tags)) {
        const tag = await paperlessService.findExistingTag(getFailedTagName(env));
        if (!tag || !doc.tags.includes(tag.id)) {
          console.log(`[INFO] Document ${doc.id} no longer carries the tag "${getFailedTagName(env)}"; processing it again.`);
          await documentModel.clearProcessingFailure(doc.id);
          return false;
        }
      }

      return true;
    } catch (error) {
      console.warn(`[WARN] Could not check the failure count of document ${doc?.id}:`, describeError(error));
      return false;
    }
  }

  // Never throws: this runs inside error handling.
  async function recordFailure(doc, error) {
    try {
      const maxAttempts = getMaxAttempts(env);
      if (maxAttempts === 0 || !doc || isBackendUnavailable(error)) {
        return { counted: false, attempts: 0, gaveUp: false };
      }

      const attempts = await documentModel.recordProcessingFailure(doc.id, describeError(error));
      if (attempts < maxAttempts) {
        console.log(`[INFO] Document ${doc.id} failed (attempt ${attempts} of ${maxAttempts}); it will be tried again at the next scan.`);
        return { counted: true, attempts, gaveUp: false };
      }

      console.warn(
        `[WARN] Document ${doc.id} failed ${attempts} times and will not be tried again. `
        + `It gets the tag "${getFailedTagName(env)}"; remove that tag to have it processed again.`
      );
      await tryTagAsFailed(doc.id);
      return { counted: true, attempts, gaveUp: true };
    } catch (trackingError) {
      console.warn(`[WARN] Could not record the failure of document ${doc?.id}:`, describeError(trackingError));
      return { counted: false, attempts: 0, gaveUp: false };
    }
  }

  return { shouldSkip, recordFailure };
}

module.exports = {
  createFailedDocumentTracker,
  getFailedTagName,
  getMaxAttempts,
  isBackendUnavailable
};
