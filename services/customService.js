const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const RestrictionPromptService = require('./restrictionPromptService');

class CustomOpenAIService {
  constructor() {
    this.client = null;
    this.tokenizer = null;
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

  _sanitizeJsonString(jsonStr) {
    return String(jsonStr || '')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
  }

  _extractJsonCandidate(raw) {
    const content = String(raw || '').trim();
    const fenceCleaned = content.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

    const firstBrace = fenceCleaned.indexOf('{');
    const lastBrace = fenceCleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return fenceCleaned.slice(firstBrace, lastBrace + 1);
    }

    return fenceCleaned;
  }

  _parseResponseJson(raw) {
    const candidate = this._extractJsonCandidate(raw);

    try {
      return JSON.parse(candidate);
    } catch (_) {
      const sanitized = this._sanitizeJsonString(candidate);
      return JSON.parse(sanitized);
    }
  }

  initialize() {
    if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    }
  }

  _sanitizeAnalysisResponse(parsedResponse) {
    const safeResponse = parsedResponse || {};
    const tags = Array.isArray(safeResponse.tags)
      ? safeResponse.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
      : [];

    return {
      title: typeof safeResponse.title === 'string' ? safeResponse.title.trim() : '',
      correspondent: typeof safeResponse.correspondent === 'string' ? safeResponse.correspondent.trim() : '',
      tags,
      document_date: typeof safeResponse.document_date === 'string' ? safeResponse.document_date.trim() : '',
      language: typeof safeResponse.language === 'string' ? safeResponse.language.trim() : '',
      document_type: typeof safeResponse.document_type === 'string' ? safeResponse.document_type.trim() : '',
      custom_fields: safeResponse.custom_fields && typeof safeResponse.custom_fields === 'object'
        ? safeResponse.custom_fields
        : {}
    };
  }

  _chunkContent(content, targetChunkTokens) {
    const text = String(content || '');
    if (!text) {
      return [];
    }

    const approxCharsPerToken = 4;
    const chunkChars = Math.max(2000, targetChunkTokens * approxCharsPerToken);
    const overlapChars = Math.min(500, Math.floor(chunkChars * 0.1));
    const step = Math.max(800, chunkChars - overlapChars);
    const chunks = [];

    for (let start = 0; start < text.length; start += step) {
      const end = Math.min(start + chunkChars, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk) {
        chunks.push({
          index: chunks.length,
          content: chunk
        });
      }

      if (end >= text.length) {
        break;
      }
    }

    return chunks;
  }

  _isContextOverflowError(error) {
    if (!error) {
      return false;
    }

    const message = String(error?.message || '').toLowerCase();
    const errorMessage = String(error?.error?.message || '').toLowerCase();
    const param = String(error?.param || error?.error?.param || '').toLowerCase();

    return message.includes('maximum context length')
      || errorMessage.includes('maximum context length')
      || param === 'input_tokens'
      || message.includes('input tokens');
  }

  async _fitChunkToInputBudget(systemPrompt, chunkContent, model, maxInputTokens) {
    let candidate = String(chunkContent || '');
    if (!candidate) {
      return candidate;
    }

    // Keep tightening until estimated (prompt + chunk) fits within input budget.
    for (let i = 0; i < 6; i += 1) {
      const combinedTokens = await calculateTotalPromptTokens(systemPrompt, [candidate], model);
      if (combinedTokens <= maxInputTokens) {
        return candidate;
      }

      const currentChunkTokens = await calculateTokens(candidate, model);
      const nextChunkTokens = Math.max(120, Math.floor(currentChunkTokens * 0.75));
      if (nextChunkTokens >= currentChunkTokens) {
        break;
      }
      candidate = await truncateToTokenLimit(candidate, nextChunkTokens, model);
    }

    return candidate;
  }

  _mergeChunkResults(chunkDocuments) {
    const validDocs = (chunkDocuments || []).filter(Boolean);
    if (validDocs.length === 0) {
      return {
        title: '',
        correspondent: '',
        tags: [],
        document_date: '',
        language: '',
        document_type: '',
        custom_fields: {}
      };
    }

    const countValues = (values) => {
      const counts = new Map();
      for (const value of values) {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized) {
          continue;
        }
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
      return counts;
    };

    const mostFrequent = (values) => {
      const counts = countValues(values);
      let bestValue = '';
      let bestCount = -1;
      for (const [value, count] of counts.entries()) {
        if (count > bestCount) {
          bestValue = value;
          bestCount = count;
        }
      }
      return bestValue;
    };

    const title = mostFrequent(validDocs.map((doc) => doc.title));
    const correspondent = mostFrequent(validDocs.map((doc) => doc.correspondent));
    const documentDate = mostFrequent(validDocs.map((doc) => doc.document_date));
    const language = mostFrequent(validDocs.map((doc) => doc.language));
    const documentType = mostFrequent(validDocs.map((doc) => doc.document_type));

    const tagCounts = new Map();
    for (const doc of validDocs) {
      for (const tag of (doc.tags || [])) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([tag]) => tag);

    const customFieldVotes = new Map();
    for (const doc of validDocs) {
      const customFields = doc.custom_fields && typeof doc.custom_fields === 'object' ? doc.custom_fields : {};
      for (const key of Object.keys(customFields)) {
        const field = customFields[key];
        if (!field || typeof field !== 'object') {
          continue;
        }

        const fieldName = typeof field.field_name === 'string' ? field.field_name.trim() : '';
        const value = typeof field.value === 'string' ? field.value.trim() : '';
        if (!fieldName || !value) {
          continue;
        }

        const voteKey = fieldName.toLowerCase();
        if (!customFieldVotes.has(voteKey)) {
          customFieldVotes.set(voteKey, {
            field_name: fieldName,
            valueCounts: new Map()
          });
        }

        const voteEntry = customFieldVotes.get(voteKey);
        voteEntry.valueCounts.set(value, (voteEntry.valueCounts.get(value) || 0) + 1);
      }
    }

    const mergedCustomFields = {};
    let customFieldIndex = 0;
    for (const voteEntry of customFieldVotes.values()) {
      let bestValue = '';
      let bestCount = -1;
      for (const [value, count] of voteEntry.valueCounts.entries()) {
        if (count > bestCount) {
          bestValue = value;
          bestCount = count;
        }
      }

      if (bestValue) {
        mergedCustomFields[customFieldIndex] = {
          field_name: voteEntry.field_name,
          value: bestValue
        };
        customFieldIndex += 1;
      }
    }

    return {
      title,
      correspondent,
      tags,
      document_date: documentDate,
      language,
      document_type: documentType,
      custom_fields: mergedCustomFields
    };
  }

  async _analyzeSingleChunk(systemPrompt, chunkContent, model, timestamp) {
    const response = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: chunkContent
        }
      ],
      temperature: 0.3,
    });

    if (!response?.choices?.[0]?.message?.content) {
      throw new Error('Invalid API response structure');
    }

    console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
    console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage?.total_tokens ?? 0}`);

    let parsedResponse;
    try {
      parsedResponse = this._parseResponseJson(response.choices[0].message.content);
      await fs.appendFile('./logs/response.txt', JSON.stringify(parsedResponse));
    } catch (error) {
      console.error('Failed to parse JSON response:', error);
      throw new Error('Invalid JSON response from API');
    }

    return {
      document: this._sanitizeAnalysisResponse(parsedResponse),
      metrics: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0
      }
    };
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    const cachePath = path.join('./public/images', `${id}.png`);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized');
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
      const model = config.custom.model;

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

      // Get system prompt based on configuration
      const correspondentInstruction = (config.limitFunctions?.activateCorrespondents !== 'no' && existingCorrespondentList && existingCorrespondentList.length > 0)
        ? `IMPORTANT: The following correspondents already exist in the system: ${Array.isArray(existingCorrespondentList) ? existingCorrespondentList.join(', ') : existingCorrespondentList}\nWhen identifying the correspondent, prefer an existing one if the document's sender is a close match. Use EXACTLY that existing name (e.g. if the document shows "MediaMarkt Saturn Media GmbH" and "MediaMarkt" is in the list, return "MediaMarkt"). Only return a completely new name if none of the existing correspondents are a reasonable match.`
        : '';
      if (config.useExistingData === 'yes' && config.restrictToExistingTags === 'no' && config.restrictToExistingCorrespondents === 'no') {
        systemPrompt = `
        Pre-existing tags: ${existingTagsList}\n\n
        Pre-existing correspondents: ${existingCorrespondentList}\n\n
        Pre-existing document types: ${existingDocumentTypesList.join(', ')}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr).replace('%EXISTING_CORRESPONDENTS%', correspondentInstruction);
        promptTags = '';
      } else {
        config.mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr).replace('%EXISTING_CORRESPONDENTS%', correspondentInstruction);
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
        promptTags = '';
      }

      // Process placeholder replacements in system prompt
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
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

      // Custom prompt override if provided
      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt');
        systemPrompt = customPrompt + '\n\n' + config.mustHavePrompt;
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const configuredResponseTokens = Number(config.responseTokens);
      let responseTokenBudget = Number.isFinite(configuredResponseTokens) && configuredResponseTokens > 0
        ? configuredResponseTokens
        : 1000;

      // Guard against self-deadlock if response budget is configured >= context window.
      if (responseTokenBudget >= maxTokens) {
        responseTokenBudget = Math.max(128, Math.floor(maxTokens * 0.1));
      }

      const reservedTokens = totalPromptTokens + responseTokenBudget;
      const availableTokens = maxTokens - reservedTokens;
      const maxInputTokens = Math.max(512, maxTokens - responseTokenBudget);

      // Validate that we have positive available tokens
      if (availableTokens <= 0) {
        console.warn(`[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`);
        throw new Error('Token limit exceeded: prompt too large for available token limit');
      }

      if (totalPromptTokens >= maxInputTokens - 100) {
        throw new Error(
          `Prompt description is too large for configured model context. `
          + `Prompt tokens: ${totalPromptTokens}, max input budget: ${maxInputTokens}. `
          + `Reduce Prompt Description or increase Token Limit.`
        );
      }

      console.log(`[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}, ResponseBudget: ${responseTokenBudget}`);
      console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
      console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

      // Keep a safety margin so Prompt + Chunk stays below model input window.
      const promptAwareChunkBudget = Math.max(300, maxInputTokens - totalPromptTokens - 96);
      const targetChunkTokens = Math.max(300, Math.floor(promptAwareChunkBudget * 0.75));
      const contentChunks = this._chunkContent(content, targetChunkTokens);
      const analysisChunks = contentChunks.length > 0 ? contentChunks : [{ index: 0, content: String(content || '') }];

      let aggregatePromptTokens = 0;
      let aggregateCompletionTokens = 0;
      let aggregateTotalTokens = 0;
      const successfulChunkDocuments = [];
      const failedChunks = [];

      for (const chunk of analysisChunks) {
        let chunkTokenBudget = targetChunkTokens;
        let lastError = null;
        let success = false;

        for (let attempt = 1; attempt <= 4; attempt += 1) {
          let chunkContent = await truncateToTokenLimit(chunk.content, chunkTokenBudget, model);
          chunkContent = await this._fitChunkToInputBudget(systemPrompt, chunkContent, model, maxInputTokens);
          try {
            const chunkResult = await this._analyzeSingleChunk(systemPrompt, chunkContent, model, timestamp);
            successfulChunkDocuments.push(chunkResult.document);
            aggregatePromptTokens += chunkResult.metrics.promptTokens;
            aggregateCompletionTokens += chunkResult.metrics.completionTokens;
            aggregateTotalTokens += chunkResult.metrics.totalTokens;
            success = true;
            break;
          } catch (chunkError) {
            lastError = chunkError;
            if (this._isContextOverflowError(chunkError) && chunkTokenBudget > 300) {
              chunkTokenBudget = Math.max(300, Math.floor(chunkTokenBudget * 0.65));
              console.warn(
                `[WARNING] Chunk ${chunk.index + 1} exceeded context, retrying with smaller budget (${chunkTokenBudget} tokens).`,
                {
                  error: chunkError.message,
                  status: chunkError.status,
                  param: chunkError.param || chunkError?.error?.param,
                  type: chunkError.type || chunkError?.error?.type,
                  maxInputTokens,
                  promptTokens: totalPromptTokens
                }
              );
              continue;
            }
            break;
          }
        }

        if (!success) {
          const errorMessage = lastError?.message || 'Unknown chunk analysis failure';
          failedChunks.push(`chunk ${chunk.index + 1}: ${errorMessage}`);
        }
      }

      if (successfulChunkDocuments.length === 0) {
        throw new Error(`Document analysis failed for all chunks. Details: ${failedChunks.slice(0, 3).join(' | ')}`);
      }

      const mergedDocument = this._mergeChunkResults(successfulChunkDocuments);
      const mappedUsage = {
        promptTokens: aggregatePromptTokens,
        completionTokens: aggregateCompletionTokens,
        totalTokens: aggregateTotalTokens
      };

      return {
        document: mergedDocument,
        metrics: mappedUsage,
        truncated: analysisChunks.length > 1,
        partial: failedChunks.length > 0,
        warnings: failedChunks
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
    const dataTokens = await calculateTokens(dataString, config.custom.model);

    if (dataTokens > maxTokens) {
      console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
      return await truncateToTokenLimit(dataString, maxTokens, config.custom.model);
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
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(content, availableTokens);

      // Make API request
      const response = await this.client.chat.completions.create({
        model: config.custom.model,
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
        temperature: 0.3,
      });

      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] Custom OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let parsedResponse;
      try {
        parsedResponse = this._parseResponseJson(response.choices[0].message.content);
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
        error: error.message
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
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      const model = config.custom.model;
      const configuredResponseTokens = Number(config.responseTokens);
      const maxTokens = Number.isFinite(configuredResponseTokens) && configuredResponseTokens > 0
        ? configuredResponseTokens
        : 1000;

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      });

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error generating text with Custom OpenAI:', error);
      throw error;
    }
  }

  async checkStatus() {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized - missing API key');
      }

      const model = config.custom.model;

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: 'Ping'
          }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });

      if (!response?.choices?.[0]?.message?.content) {
        return { status: 'error' };
      }

      return { status: 'ok', model: model };
    } catch (error) {
      console.error('Error generating text with Custom OpenAI:', error);
      return { status: 'error' };
    }
  }
}

module.exports = new CustomOpenAIService();
