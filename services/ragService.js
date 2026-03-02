// services/ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');

const DEFAULT_MAX_SOURCES = 5;
const BROAD_MAX_SOURCES = 40;
const MAX_ALLOWED_SOURCES = 100;
const COVERAGE_QUERY_PATTERNS = [
  /\bhow many\b/i,
  /\bnumber of\b/i,
  /\bcount\b/i,
  /\btotal\b/i,
  /\bwie viele\b/i,
  /\banzahl\b/i,
  /\bcombien\b/i,
  /\bcu[aá]nt[oa]s?\b/i,
  /\bquant[ioe]\b/i
];
const CORPUS_COUNT_HINT_PATTERNS = [
  /\bcorpus\b/i,
  /\bindex(?:ed)?\b/i,
  /\ball documents?\b/i
];

class RagService {
  constructor() {
    this.baseUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
  }

  parseTimeoutMs(value, fallbackMs) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
  }

  withTimeout(promise, timeoutMs, timeoutMessage) {
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

  isCoverageQuestion(question = '') {
    return COVERAGE_QUERY_PATTERNS.some((pattern) => pattern.test(question));
  }

  isCorpusCountQuestion(question = '') {
    if (!this.isCoverageQuestion(question)) {
      return false;
    }
    return CORPUS_COUNT_HINT_PATTERNS.some((pattern) => pattern.test(question));
  }

  resolveMaxSources(question, requestedMaxSources) {
    const parsedRequestedSources = Number.parseInt(requestedMaxSources, 10);
    const hasRequestedSources = Number.isInteger(parsedRequestedSources) && parsedRequestedSources > 0;
    const baseValue = this.isCoverageQuestion(question) ? BROAD_MAX_SOURCES : DEFAULT_MAX_SOURCES;
    const resolvedValue = hasRequestedSources ? parsedRequestedSources : baseValue;
    return Math.min(Math.max(resolvedValue, 1), MAX_ALLOWED_SOURCES);
  }

  /**
   * Check if the RAG service is available and ready
   * @returns {Promise<{status: string, index_ready: boolean, data_loaded: boolean}>}
   */
  async checkStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/status`);
      //make test call to the LLM service to check if it is available
      return response.data;
    } catch (error) {
      console.error('Error checking RAG service status:', error.message);
      return {
        server_up: false,
        data_loaded: false,
        index_ready: false,
        error: error.message
      };
    }
  }

  /**
   * Search for documents matching a query
   * @param {string} query - The search query
   * @param {Object} filters - Optional filters for search
   * @returns {Promise<Array>} - Array of search results
   */
  async search(query, filters = {}) {
    try {
      const response = await axios.post(`${this.baseUrl}/search`, {
        query,
        ...filters
      });
      return response.data;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Ask a question about documents and get an AI-generated answer in the same language as the question
   * @param {string} question - The question to ask
   * @returns {Promise<{answer: string, sources: Array}>} - AI response and source documents
   */
  async askQuestion(question, options = {}) {
    try {
      const coverageQuestion = this.isCoverageQuestion(question);
      const corpusCountQuestion = this.isCorpusCountQuestion(question);
      const maxSources = this.resolveMaxSources(question, options.maxSources);
      const contextTimeoutMs = this.parseTimeoutMs(process.env.RAG_CONTEXT_TIMEOUT_MS, 30000);
      // 1. Get context from the RAG service
      const response = await this.withTimeout(
        axios.post(
          `${this.baseUrl}/context`,
          {
            question,
            max_sources: maxSources
          },
          { timeout: contextTimeoutMs }
        ),
        contextTimeoutMs,
        `RAG context request timed out after ${contextTimeoutMs}ms`
      );
      
      const {
        context,
        sources = [],
        total_matches: totalMatches,
        coverage_mode: coverageMode,
        search_limit: searchLimit,
        result_cap_hit: resultCapHit
      } = response.data;
      
      // 2. Fetch full content for each source document using doc_id
      let enhancedContext = context;
      const shouldFetchFullContent = !coverageQuestion;
      
      if (shouldFetchFullContent && sources.length > 0) {
        // Fetch full document content for each source
        const fullDocContents = await Promise.all(
          sources.map(async (source) => {
            if (source.doc_id) {
              try {
                const fullContent = await paperlessService.getDocumentContent(source.doc_id);
                return `Full document content for ${source.title || 'Document ' + source.doc_id}:\n${fullContent}`;
              } catch (error) {
                console.error(`Error fetching content for document ${source.doc_id}:`, error.message);
                return '';
              }
            }
            return '';
          })
        );
        
        // Combine original context with full document contents
        enhancedContext = context + '\n\n' + fullDocContents.filter(content => content).join('\n\n');
      }

      const resolvedCoverageMode = coverageMode || (coverageQuestion ? 'broad' : 'focused');
      const retrievedMatchCount = Number.isInteger(totalMatches) ? totalMatches : sources.length;
      const sourceCount = sources.length;
      const retrievalCapped = resultCapHit === true;
      const retrievalLimit = Number.isInteger(searchLimit) && searchLimit > 0 ? searchLimit : null;

      if (corpusCountQuestion) {
        try {
          const indexingStatus = await this.withTimeout(
            axios.get(`${this.baseUrl}/indexing/status`, { timeout: contextTimeoutMs }),
            contextTimeoutMs,
            `RAG indexing status request timed out after ${contextTimeoutMs}ms`
          );
          const corpusDocumentCount = Number.parseInt(indexingStatus.data?.documents_count, 10);
          if (Number.isInteger(corpusDocumentCount) && corpusDocumentCount >= 0) {
            return {
              answer: `The indexed corpus currently contains ${corpusDocumentCount} documents.`,
              sources,
              coverage: {
                mode: resolvedCoverageMode,
                total_matches: retrievedMatchCount,
                sources_returned: sourceCount,
                result_cap_hit: retrievalCapped,
                corpus_documents: corpusDocumentCount,
                answered_from: 'indexing_status'
              }
            };
          }
        } catch (error) {
          console.warn('Failed to fetch deterministic corpus count from indexing status:', error.message);
        }
      }
      
      // 3. Use AI service to generate an answer based on the enhanced context
      const aiService = AIServiceFactory.getService();
      const aiTimeoutMs = this.parseTimeoutMs(process.env.RAG_AI_TIMEOUT_MS, 120000);
      
      // Create a language-agnostic prompt that works in any language
      const prompt = `
        You are a helpful assistant that answers questions about documents.

        Answer the following question precisely, based on the provided documents:

        Question: ${question}

        Retrieval metadata:
        - Coverage mode: ${resolvedCoverageMode}
        - Matching documents in retrieval set: ${retrievedMatchCount}
        - Sources included in context: ${sourceCount}
        - Retrieval limit reached: ${retrievalCapped ? 'yes' : 'no'}
        ${retrievalLimit ? `- Retrieval limit: ${retrievalLimit}` : ''}

        Context from relevant documents:
        ${enhancedContext}

        Important instructions:
        - Use ONLY information from the provided documents
        - For questions about totals, counts, or "how many", use "Matching documents in retrieval set" as the authoritative number
        - If "Retrieval limit reached" is "yes" and the user asks for a total, clearly answer as "at least" that number
        - If the answer is not contained in the documents, respond: "This information is not contained in the documents." (in the same language as the question)
        - Avoid assumptions or speculation beyond the given context
        - Answer in the same language as the question was asked
        - Do not mention document numbers or source references, answer as if it were a natural conversation
        `;

      let answer;
      try {
        answer = await this.withTimeout(
          aiService.generateText(prompt),
          aiTimeoutMs,
          `AI response timed out after ${aiTimeoutMs}ms`
        );
      } catch (error) {
        console.error('Error generating answer with AI service:', error);
        if (error && error.code === 'ETIMEDOUT') {
          answer = `The AI response timed out after ${Math.round(aiTimeoutMs / 1000)} seconds. Please try again later.`;
        } else {
          answer = "An error occurred while generating an answer. Please try again later.";
        }
      }
      
      return {
        answer,
        sources,
        coverage: {
          mode: resolvedCoverageMode,
          total_matches: retrievedMatchCount,
          sources_returned: sourceCount,
          result_cap_hit: retrievalCapped
        }
      };
    } catch (error) {
      console.error('Error in askQuestion:', error);
      if (error && (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')) {
        throw error;
      }
      throw new Error("An error occurred while processing your question. Please try again later.");
    }
  }

  /**
   * Start indexing documents in the RAG service
   * @param {boolean} force - Whether to force refresh from source
   * @returns {Promise<Object>} - Indexing status
   */
  async indexDocuments(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/start`, { 
        force, 
        background: true 
      });
      return response.data;
    } catch (error) {
      console.error('Error indexing documents:', error);
      throw error;
    }
  }

  /**
   * Check if the RAG service needs document updates
   * @returns {Promise<{needs_update: boolean, message: string}>}
   */
  async checkForUpdates() {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/check`);
      return response.data;
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Get current indexing status
   * @returns {Promise<Object>} - Current indexing status
   */
  async getIndexingStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/indexing/status`);
      return response.data;
    } catch (error) {
      console.error('Error getting indexing status:', error);
      throw error;
    }
  }

  /**
   * Initialize the RAG service
   * @param {boolean} force - Whether to force initialization
   * @returns {Promise<Object>} - Initialization status
   */
  async initialize(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/initialize`, { force });
      return response.data;
    } catch (error) {
      console.error('Error initializing RAG service:', error);
      throw error;
    }
  }

  /**
   * Get AI status
   * @returns {Promise<{status: string}>}
   */
  async getAIStatus() {
    try {
      const aiService = AIServiceFactory.getService();
      const status = await aiService.checkStatus();
      return status;
    } catch (error) {
      console.error('Error checking AI service status:', error);
      throw error;
    }
  }
}


module.exports = new RagService();
