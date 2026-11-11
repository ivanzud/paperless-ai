'use strict';

const fs = require('fs').promises;
const path = require('path');

// Thumbnails show the first page of a document. They used to be cached below
// public/, which the web server hands out to anybody without a login. They are
// kept in the data directory instead and only served by the authenticated
// /thumb/<id> route.
function getThumbnailCacheDir() {
  return path.join(process.cwd(), 'data', 'thumb-cache');
}

// Null for anything that is not a plain document id, so that a crafted id can
// never point outside the cache directory.
function getThumbnailCachePath(documentId) {
  const id = String(documentId ?? '').trim();
  if (!/^\d{1,15}$/.test(id)) {
    return null;
  }
  return path.join(getThumbnailCacheDir(), `${id}.png`);
}

// Fetches a thumbnail into the cache unless it is there already. The cache is
// a convenience for the UI: a failure here must never fail the analysis of
// the document, so this only reports whether a cached file exists afterwards.
async function ensureThumbnailCached(documentId, fetchThumbnail) {
  const cachePath = getThumbnailCachePath(documentId);
  if (!cachePath) {
    return null;
  }

  try {
    await fs.access(cachePath);
    return cachePath;
  } catch (_) {
    // not cached yet
  }

  try {
    const thumbnailData = await fetchThumbnail(documentId);
    if (!thumbnailData) {
      return null;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, thumbnailData);
    return cachePath;
  } catch (error) {
    console.warn(`[WARN] Could not cache the thumbnail of document ${documentId}:`, error.message);
    return null;
  }
}

module.exports = {
  ensureThumbnailCached,
  getThumbnailCacheDir,
  getThumbnailCachePath
};
