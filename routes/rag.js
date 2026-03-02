// routes/rag.js
const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');

function parseTimeoutMs(value, fallbackMs) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const timeoutError = new Error(timeoutMessage);
      timeoutError.code = 'ETIMEDOUT';
      reject(timeoutError);
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Search documents
 */
router.post('/search', async (req, res) => {
  try {
    const { query, from_date, to_date, correspondent } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const filters = {};
    if (from_date) filters.from_date = from_date;
    if (to_date) filters.to_date = to_date;
    if (correspondent) filters.correspondent = correspondent;
    
    const results = await ragService.search(query, filters);
    res.json(results);
  } catch (error) {
    console.error('Error in /api/rag/search:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Ask a question about documents
 */
router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const askTimeoutMs = parseTimeoutMs(process.env.RAG_ASK_TIMEOUT_MS, 125000);
    const result = await withTimeout(
      ragService.askQuestion(question),
      askTimeoutMs,
      `RAG chat request timed out after ${Math.round(askTimeoutMs / 1000)} seconds`
    );
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/ask:', error);
    if (error && (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')) {
      return res.status(504).json({ error: error.message || 'RAG chat request timed out' });
    }
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Start document indexing
 */
router.post('/index', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.indexDocuments(force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get indexing status
 */
router.get('/index/status', async (req, res) => {
  try {
    const status = await ragService.getIndexingStatus();
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/index/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Check if updates are needed
 */
router.get('/index/check', async (req, res) => {
  try {
    const result = await ragService.checkForUpdates();
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index/check:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get RAG service status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await ragService.checkStatus();
    const aiStatus = await ragService.getAIStatus();
    // Combine RAG and AI status
    status.ai_status = aiStatus && typeof aiStatus.status === 'string' ? aiStatus.status : 'error';
    status.ai_model = aiStatus && typeof aiStatus.model === 'string' && aiStatus.model.trim() ? aiStatus.model : null;
    // console.log('RAG Status:', status);
    // console.log('AI Status:', aiStatus);
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Initialize RAG service
 */
router.post('/initialize', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.initialize(force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/initialize:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

module.exports = router;
