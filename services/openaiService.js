const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const { model } = require('./ollamaService');
const RestrictionPromptService = require('./restrictionPromptService');

class OpenAIService {
  constructor() {
    this.client = null;
  }

  _isRateLimitError(error) {
    if (!error) return false;

    const status = error.status || error?.response?.status || error?.error?.status;
    if (status === 429) {
      return true;
    }

    const code = String(error.code || error?.error?.code || '').toLowerCase();
    if (code.includes('rate_limit')) {
      return true;
    }

    const message = String(error.message || error?.error?.message || '').toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429')
    );
  }

  _getHeaderValue(headers, headerName) {
    if (!headers || typeof headers !== 'object') {
      return null;
    }

    const targetHeader = String(headerName).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === targetHeader) {
        return value;
      }
    }
    return null;
  }

  _getRetryDelayMs(error, attempt) {
    const headers = error?.headers || error?.response?.headers || error?.error?.headers;
    const retryAfterMsHeader = this._getHeaderValue(headers, 'retry-after-ms');
    if (retryAfterMsHeader != null) {
      const parsedMs = Number(retryAfterMsHeader);
      if (Number.isFinite(parsedMs) && parsedMs > 0) {
        return Math.min(30000, Math.max(250, parsedMs));
      }
    }

    const retryAfterHeader = this._getHeaderValue(headers, 'retry-after');
    if (retryAfterHeader != null) {
      const parsedSeconds = Number(retryAfterHeader);
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        return Math.min(30000, Math.max(250, parsedSeconds * 1000));
      }

      const parsedDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(parsedDate)) {
        const waitMs = parsedDate - Date.now();
        if (waitMs > 0) {
          return Math.min(30000, Math.max(250, waitMs));
        }
      }
    }

    const baseDelay = 1000;
    const exponentialDelay = baseDelay * (2 ** (attempt - 1));
    return Math.min(30000, exponentialDelay);
  }

  async _sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _createChatCompletionWithRetry(payload, context = 'OpenAI request') {
    const maxAttempts = 4;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.client.chat.completions.create(payload);
      } catch (error) {
        lastError = error;

        if (!this._isRateLimitError(error) || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = this._getRetryDelayMs(error, attempt);
        console.warn(
          `[WARNING] ${context} rate limited (429). Retrying attempt ${attempt + 1}/${maxAttempts} after ${delayMs}ms.`
        );
        await this._sleep(delayMs);
      }
    }

    throw lastError;
  }

  _normalizeNotesField(parsedResponse) {
    if (!parsedResponse || typeof parsedResponse !== 'object') return parsedResponse;
    if (parsedResponse.notes == null && parsedResponse.note != null) {
      parsedResponse.notes = parsedResponse.note;
    }
    if (
      parsedResponse.notes != null &&
      !Array.isArray(parsedResponse.notes) &&
      typeof parsedResponse.notes !== 'string'
    ) {
      parsedResponse.notes = String(parsedResponse.notes);
    }
    return parsedResponse;
  }

  initialize() {
    if (!this.client && config.aiProvider === 'ollama') {
      this.client = new OpenAI({
        baseURL: config.ollama.apiUrl + '/v1',
        apiKey: 'ollama'
      });
    } else if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    } else if (!this.client && config.aiProvider === 'openai') {
      if (!this.client && config.openai.apiKey) {
        this.client = new OpenAI({
          apiKey: config.openai.apiKey
        });
      }
    }
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    const cachePath = path.join('./public/images', `${id}.png`);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('OpenAI client not initialized');
      }

      // Handle thumbnail caching
      try {
        await fs.access(cachePath);
        console.log('[DEBUG] Thumbnail already cached');
      } catch (err) {
        console.log('Thumbnail not cached, fetching from Paperless');

        const thumbnailData = await paperlessService.getThumbnailImage(id);

        if (!thumbnailData) {
          console.warn('Thumbnail nicht gefunden');
        }

        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, thumbnailData);
      }

      // Format existing tags
      let existingTagsList = existingTags.join(', ');

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData = await this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn('[WARNING] External API data validation failed:', error.message);
          validatedExternalApiData = null;
        }
      }

      let systemPrompt = '';
      let promptTags = '';
      const model = process.env.OPENAI_MODEL;

      // Parse CUSTOM_FIELDS from environment variable
      let customFieldsObj;
      try {
        customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
      } catch (error) {
        console.error('Failed to parse CUSTOM_FIELDS:', error);
        customFieldsObj = { custom_fields: [] };
      }

      // Generate custom fields template for the prompt
      const customFieldsTemplate = {};

      customFieldsObj.custom_fields.forEach((field, index) => {
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: "Fill in the value based on your analysis"
        };
      });

      // Convert template to string for replacement and wrap in custom_fields
      const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map(line => '    ' + line)  // Add proper indentation
        .join('\n');

      // Get system prompt and model
      const correspondentInstruction = (config.limitFunctions?.activateCorrespondents !== 'no' && existingCorrespondentList && existingCorrespondentList.length > 0)
        ? `IMPORTANT: The following correspondents already exist in the system: ${Array.isArray(existingCorrespondentList) ? existingCorrespondentList.join(', ') : existingCorrespondentList}\nWhen identifying the correspondent, prefer an existing one if the document's sender is a close match. Use EXACTLY that existing name (e.g. if the document shows "MediaMarkt Saturn Media GmbH" and "MediaMarkt" is in the list, return "MediaMarkt"). Only return a completely new name if none of the existing correspondents are a reasonable match.`
        : '';
      const mustHavePrompt = config.mustHavePrompt
        .replace('%CUSTOMFIELDS%', customFieldsStr)
        .replace('%EXISTING_CORRESPONDENTS%', correspondentInstruction);

      if (config.useExistingData === 'yes' && config.restrictToExistingTags === 'no' && config.restrictToExistingCorrespondents === 'no') {
        systemPrompt = `
        Pre-existing tags: ${existingTagsList}\n\n
        Pre-existing correspondents: ${existingCorrespondentList}\n\n
        Pre-existing document types: ${existingDocumentTypesList.join(', ')}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
        promptTags = '';
      } else {
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
        promptTags = '';
      }

      // Process placeholder replacements in system prompt
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        config
      );

      // Include validated external API data if available
      if (validatedExternalApiData) {
        systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
      }

      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt via WebHook');
        systemPrompt = customPrompt + '\n\n' + mustHavePrompt;
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Validate that we have positive available tokens
      if (availableTokens <= 0) {
        console.warn(`[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`);
        throw new Error('Token limit exceeded: prompt too large for available token limit');
      }

      console.log(`[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`);
      console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
      console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

      const truncatedContent = await truncateToTokenLimit(content, availableTokens, model);

      await writePromptToFile(systemPrompt, truncatedContent);

      const response = await this._createChatCompletionWithRetry({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        ...(model !== 'o3-mini' && { temperature: 0.3 }),
      }, 'analyzeDocument');

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
        this._normalizeNotesField(parsedResponse);
        //write to file and append to the file (txt)
        fs.appendFile('./logs/response.txt', jsonContent, (err) => {
          if (err) throw err;
        });
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null, notes: null },
        metrics: null,
        error: error.message,
        errorDetails: {
          status: error.status || error?.error?.status || null,
          code: error.code || error?.error?.code || null,
          type: error.type || error?.error?.type || null,
          param: error.param || error?.error?.param || null
        }
      };
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {string} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString = typeof apiData === 'object'
      ? JSON.stringify(apiData, null, 2)
      : String(apiData);

    // Calculate tokens for the data
    const dataTokens = await calculateTokens(dataString, process.env.OPENAI_MODEL);

    if (dataTokens > maxTokens) {
      console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
      return await truncateToTokenLimit(dataString, maxTokens, process.env.OPENAI_MODEL);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  async analyzePlayground(content, prompt) {
    const musthavePrompt = `
    Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:  
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens); // Reserve for response
      const availableTokens = maxTokens - reservedTokens;

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(content, availableTokens);
      const model = process.env.OPENAI_MODEL;
      // Make API request
      const response = await this._createChatCompletionWithRetry({
        model: model,
        messages: [
          {
            role: "system",
            content: prompt + musthavePrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        ...(model !== 'o3-mini' && { temperature: 0.3 }),
      }, 'analyzePlayground');

      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
        this._normalizeNotesField(parsedResponse);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null, notes: null },
        metrics: null,
        error: error.message,
        errorDetails: {
          status: error.status || error?.error?.status || null,
          code: error.code || error?.error?.code || null,
          type: error.type || error?.error?.type || null,
          param: error.param || error?.error?.param || null
        }
      };
    }
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      const model = process.env.OPENAI_MODEL || config.openai.model;

      const response = await this._createChatCompletionWithRetry({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      }, 'generateText');

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error generating text with OpenAI:', error);
      throw error;
    }
  }

  async checkStatus() {
    // send test request to OpenAI API and respond with 'ok' or 'error'
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }
      const response = await this._createChatCompletionWithRetry({
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: "Test"
          }
        ],
        temperature: 0.7
      }, 'checkStatus');
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }
      return { status: 'ok', model: process.env.OPENAI_MODEL };
    } catch (error) {
      console.error('Error checking OpenAI status:', error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new OpenAIService();
