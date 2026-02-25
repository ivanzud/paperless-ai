// services/chatService.js
const OpenAIService = require('./openaiService');
const PaperlessService = require('./paperlessService');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const { OpenAI } = require('openai');

const DEFAULT_CHUNK_SIZE_CHARS = Number(process.env.CHAT_CHUNK_SIZE_CHARS || 2200);
const DEFAULT_CHUNK_OVERLAP_CHARS = Number(process.env.CHAT_CHUNK_OVERLAP_CHARS || 250);
const DEFAULT_MAX_RETRIEVED_CHUNKS = Number(process.env.CHAT_MAX_RETRIEVED_CHUNKS || 6);
const DEFAULT_MAX_HISTORY_MESSAGES = Number(process.env.CHAT_MAX_HISTORY_MESSAGES || 10);
const DEFAULT_MIN_PROMPT_BUDGET_TOKENS = Number(process.env.CHAT_MIN_PROMPT_BUDGET_TOKENS || 1500);
const APPROX_CHARS_PER_TOKEN = 4;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'when', 'where', 'which', 'about', 'into',
  'your', 'you', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'but', 'can', 'could', 'should', 'would',
  'who', 'why', 'how', 'its', 'their', 'there', 'then', 'than', 'also', 'them', 'they', 'his', 'her', 'she',
  'him', 'our', 'ours', 'out', 'all', 'any', 'some', 'please', 'document', 'tell', 'give', 'summarize'
]);

class ChatService {
  constructor() {
    this.chats = new Map();
    this.tempDir = path.join(os.tmpdir(), 'paperless-chat');
    
    // Create temporary directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Downloads the original file from Paperless
   * @param {string} documentId - The ID of the document
   * @returns {Promise<{filePath: string, filename: string, mimeType: string}>}
   */
  async downloadDocument(documentId) {
    try {
      const document = await PaperlessService.getDocument(documentId);
      const tempFilePath = path.join(this.tempDir, `${documentId}_${document.original_filename}`);
      
      // Create download stream
      const response = await PaperlessService.client.get(`/documents/${documentId}/download/`, {
        responseType: 'stream'
      });

      // Save file temporarily
      await pipeline(
        response.data,
        fs.createWriteStream(tempFilePath)
      );

      return {
        filePath: tempFilePath,
        filename: document.original_filename,
        mimeType: document.mime_type
      };
    } catch (error) {
      console.error(`Error downloading document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Initializes a new chat for a document
   * @param {string} documentId - The ID of the document
   */
  async initializeChat(documentId) {
    try {
      // Get document information
      const document = await PaperlessService.getDocument(documentId);
      let documentContent;

      try {
        documentContent = await PaperlessService.getDocumentContent(documentId);
      } catch (error) {
        console.warn('Could not get direct document content, trying file download...', error);
        const { filePath } = await this.downloadDocument(documentId);
        try {
          documentContent = await fs.promises.readFile(filePath, 'utf8');
        } catch (readError) {
          throw new Error(`Failed to extract readable text for document ${documentId}: ${readError.message}`);
        } finally {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }

      if (!documentContent || !documentContent.trim()) {
        throw new Error(`Document ${documentId} has no readable content for chat`);
      }

      const documentChunks = this.chunkText(documentContent);
      
      this.chats.set(documentId, {
        messages: [],
        documentTitle: document.title,
        documentChunks
      });
      
      return {
        documentTitle: document.title,
        initialized: true,
        chunkCount: documentChunks.length
      };
    } catch (error) {
      console.error(`Error initializing chat for document ${documentId}:`, error);
      throw error;
    }
  }

  estimateTokens(text) {
    return Math.ceil((text || '').length / APPROX_CHARS_PER_TOKEN);
  }

  getModelForProvider(aiProvider) {
    if (aiProvider === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-4';
    }
    if (aiProvider === 'custom') {
      return process.env.CUSTOM_MODEL;
    }
    if (aiProvider === 'azure') {
      return process.env.AZURE_DEPLOYMENT_NAME;
    }
    if (aiProvider === 'ollama') {
      return process.env.OLLAMA_MODEL;
    }
    return process.env.OPENAI_MODEL || 'gpt-4';
  }

  chunkText(content) {
    const normalized = String(content || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u0000/g, '')
      .trim();

    if (!normalized) {
      return [];
    }

    const chunks = [];
    const step = Math.max(DEFAULT_CHUNK_SIZE_CHARS - DEFAULT_CHUNK_OVERLAP_CHARS, 500);

    for (let start = 0; start < normalized.length; start += step) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE_CHARS, normalized.length);
      const text = normalized.slice(start, end).trim();
      if (text) {
        chunks.push({
          index: chunks.length,
          content: text,
          normalized: text.toLowerCase()
        });
      }
      if (end >= normalized.length) {
        break;
      }
    }

    return chunks;
  }

  extractTerms(text) {
    const terms = (String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
      .filter((word) => !STOP_WORDS.has(word));
    return [...new Set(terms)];
  }

  selectRelevantChunks(chatData, userMessage) {
    const chunks = chatData.documentChunks || [];
    if (chunks.length === 0) {
      return [];
    }

    const query = String(userMessage || '').toLowerCase().trim();
    const terms = this.extractTerms(userMessage);

    const scored = chunks.map((chunk) => {
      let score = 0;
      for (const term of terms) {
        if (chunk.normalized.includes(term)) {
          score += 2;
        }
      }
      if (query.length > 20 && chunk.normalized.includes(query)) {
        score += 5;
      }
      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);

    let selected = scored
      .filter((item) => item.score > 0)
      .slice(0, DEFAULT_MAX_RETRIEVED_CHUNKS)
      .map((item) => item.chunk);

    if (selected.length === 0) {
      selected = chunks.slice(0, Math.min(DEFAULT_MAX_RETRIEVED_CHUNKS, chunks.length));
    }

    return selected.sort((a, b) => a.index - b.index);
  }

  limitHistoryMessages(messages, tokenBudget) {
    const limited = [];
    let usedTokens = 0;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role === 'system') {
        continue;
      }

      const messageTokens = this.estimateTokens(message.content) + 8;
      if (limited.length > 0 && usedTokens + messageTokens > tokenBudget) {
        break;
      }

      limited.push(message);
      usedTokens += messageTokens;

      if (limited.length >= DEFAULT_MAX_HISTORY_MESSAGES) {
        break;
      }
    }

    return limited.reverse();
  }

  buildModelMessages(chatData, userMessage) {
    const aiProvider = process.env.AI_PROVIDER;
    const maxTokens = Math.max(Number(config.tokenLimit) || 8192, 1024);
    const responseTokens = Math.max(Number(config.responseTokens) || 1000, 256);
    const promptBudget = Math.max(maxTokens - responseTokens, DEFAULT_MIN_PROMPT_BUDGET_TOKENS);
    const contextBudget = Math.floor(promptBudget * 0.55);
    const historyBudget = Math.floor(promptBudget * 0.35);

    const selectedChunks = this.selectRelevantChunks(chatData, userMessage);
    const contextSections = [];
    let usedContextTokens = 0;

    for (const chunk of selectedChunks) {
      const section = `[Chunk ${chunk.index + 1}]\n${chunk.content}`;
      const sectionTokens = this.estimateTokens(section);

      if (contextSections.length > 0 && usedContextTokens + sectionTokens > contextBudget) {
        break;
      }

      contextSections.push(section);
      usedContextTokens += sectionTokens;
    }

    if (contextSections.length === 0 && selectedChunks.length > 0) {
      contextSections.push(`[Chunk ${selectedChunks[0].index + 1}]\n${selectedChunks[0].content}`);
    }

    const systemMessage = [
      `You are a helpful assistant for the document "${chatData.documentTitle}".`,
      'Use the provided document excerpts as the primary source of truth.',
      "If the answer is not present in the excerpts, say that clearly instead of guessing.",
      'When relevant, cite chunk numbers in your answer (for example: "Chunk 4").'
    ].join(' ');

    const contextMessage = [
      `Document title: ${chatData.documentTitle}`,
      'Relevant document excerpts:',
      contextSections.join('\n\n')
    ].join('\n\n');

    const historyMessages = this.limitHistoryMessages(chatData.messages || [], historyBudget);

    return [
      { role: 'system', content: systemMessage },
      { role: 'system', content: contextMessage },
      ...historyMessages,
      { role: 'user', content: userMessage }
    ];
  }

  createClient(aiProvider) {
    if (aiProvider === 'openai') {
      OpenAIService.initialize();
      return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }

    if (aiProvider === 'custom') {
      return new OpenAI({
        baseURL: process.env.CUSTOM_BASE_URL,
        apiKey: process.env.CUSTOM_API_KEY
      });
    }

    if (aiProvider === 'azure') {
      return new OpenAI({
        apiKey: process.env.AZURE_API_KEY,
        baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
        defaultQuery: { 'api-version': process.env.AZURE_API_VERSION }
      });
    }

    if (aiProvider === 'ollama') {
      return new OpenAI({
        baseURL: `${process.env.OLLAMA_API_URL}/v1`,
        apiKey: 'ollama'
      });
    }

    throw new Error('AI Provider not configured');
  }

  async sendMessageStream(documentId, userMessage, res) {
    try {
      if (!this.chats.has(documentId)) {
        await this.initializeChat(documentId);
      }

      const chatData = this.chats.get(documentId);
      const modelMessages = this.buildModelMessages(chatData, userMessage);

      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      let fullResponse = '';
      const aiProvider = process.env.AI_PROVIDER;
      const client = this.createClient(aiProvider);
      const model = this.getModelForProvider(aiProvider);

      const stream = await client.chat.completions.create({
        model,
        messages: modelMessages,
        stream: true
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      // Add the complete response to chat history
      chatData.messages.push({
        role: "user",
        content: userMessage
      });
      chatData.messages.push({
        role: "assistant",
        content: fullResponse
      });
      this.chats.set(documentId, chatData);

      // End the stream
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      console.error(`Error in sendMessageStream:`, error);
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }

  getChatHistory(documentId) {
    const chatData = this.chats.get(documentId);
    return chatData ? chatData.messages : [];
  }

  chatExists(documentId) {
    return this.chats.has(documentId);
  }

  async deleteChat(documentId) {
    this.chats.delete(documentId);
  }

  async cleanup() {
    try {
      for (const documentId of this.chats.keys()) {
        await this.deleteChat(documentId);
      }
      if (fs.existsSync(this.tempDir)) {
        await fs.promises.rm(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('Error cleaning up ChatService:', error);
    }
  }
}

module.exports = new ChatService();
