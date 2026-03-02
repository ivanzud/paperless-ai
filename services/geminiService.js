const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const RestrictionPromptService = require('./restrictionPromptService');

class GeminiService {
  constructor() {
    this.genAI = null;
    this.fileManager = null;
  }

  initialize() {
    const apiKey = process.env.GEMINI_API_KEY || config.custom.apiKey;
    if (!this.genAI && apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.fileManager = new GoogleAIFileManager(apiKey);
    }
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.genAI) {
        throw new Error('Gemini client not initialized - missing API key');
      }

      console.log(`[DEBUG] [${timestamp}] Starting native Gemini analysis for document ${id}`);

      // 1. Original-PDF von Paperless herunterladen
      const pdfBuffer = await paperlessService.downloadDocument(id);
      if (!pdfBuffer) {
        throw new Error(`Unable to download PDF for Document ${id}.`);
      }

      // 2. Temporär speichern
      const tempPdfPath = path.join(os.tmpdir(), `paperless_doc_${id}.pdf`);
      await fs.writeFile(tempPdfPath, pdfBuffer);

      // 3. Datei zu Gemini hochladen
      console.log(`[DEBUG] Uploading PDF to Gemini...`);
      const uploadResult = await this.fileManager.uploadFile(tempPdfPath, {
        mimeType: 'application/pdf',
        displayName: `Document ${id}`,
      });
      console.log(`[DEBUG] Uploaded successfully as ${uploadResult.file.uri}`);

      // 4. Prompt zusammenbauen
      let customFieldsObj;
      try {
        customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS || '{"custom_fields": []}');
      } catch (error) {
        customFieldsObj = { custom_fields: [] };
      }

      const customFieldsTemplate = {};
      customFieldsObj.custom_fields.forEach((field, index) => {
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: "Fill in the value based on your analysis"
        };
      });

      const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map(line => '    ' + line)
        .join('\n');

      const correspondentInstruction = (config.limitFunctions?.activateCorrespondents !== 'no' && existingCorrespondentList && existingCorrespondentList.length > 0)
        ? `IMPORTANT: The following correspondents already exist in the system: ${Array.isArray(existingCorrespondentList) ? existingCorrespondentList.join(', ') : existingCorrespondentList}\nWhen identifying the correspondent, prefer an existing one if the document's sender is a close match. Use EXACTLY that existing name (e.g. if the document shows "MediaMarkt Saturn Media GmbH" and "MediaMarkt" is in the list, return "MediaMarkt"). Only return a completely new name if none of the existing correspondents are a reasonable match.`
        : '';
      let mustHavePrompt = config.mustHavePrompt
        .replace('%CUSTOMFIELDS%', customFieldsStr)
        .replace('%EXISTING_CORRESPONDENTS%', correspondentInstruction);
      let systemPrompt = '';

      if (config.useExistingData === 'yes' && config.restrictToExistingTags === 'no' && config.restrictToExistingCorrespondents === 'no') {
        systemPrompt = `
        Pre-existing tags: ${existingTags.join(', ')}\n\n
        Pre-existing correspondents: ${existingCorrespondentList}\n\n
        Pre-existing document types: ${existingDocumentTypesList.join(', ')}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
      } else {
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
      }

      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        config
      );

      if (customPrompt) {
        systemPrompt = customPrompt + '\n\n' + mustHavePrompt;
      }

      if (options.extractContent) {
        systemPrompt += `\n\nIMPORTANT: This document has no pre-extracted text (OCR was empty). In addition to the metadata fields above, extract all readable text from the PDF and include it in the JSON response as an additional "extracted_content" field containing the full document text.`;
      }

      // 5. Gemini Modell aufrufen
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const model = this.genAI.getGenerativeModel({ model: modelName });

      console.log(`[DEBUG] Requesting generation from ${modelName}...`);
      const result = await model.generateContent([
        systemPrompt,
        {
          fileData: {
            mimeType: uploadResult.file.mimeType,
            fileUri: uploadResult.file.uri
          }
        }
      ]);

      const text = result.response.text();
      const usage = result.response.usageMetadata || {};
      const metrics = {
        promptTokens: usage.promptTokenCount || 0,
        completionTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0
      };

      console.log(`[DEBUG] Token usage - Prompt: ${metrics.promptTokens}, Completion: ${metrics.completionTokens}, Total: ${metrics.totalTokens}`);

      // 6. Cleanup: Lokale Temp-Datei und Datei auf Google-Servern löschen
      await fs.unlink(tempPdfPath).catch(e => console.error('Error deleting temp PDF:', e));
      await this.fileManager.deleteFile(uploadResult.file.name).catch(e => console.error('Error deleting file from Gemini:', e));

      // 7. JSON bereinigen und parsen
      let jsonContent = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from Gemini');
      }

      return {
        document: parsedResponse,
        metrics: metrics,
        truncated: false
      };

    } catch (error) {
      console.error('Failed to analyze document with Gemini:', error);
      return {
        document: { tags: [], correspondent: null },
        metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        error: error.message
      };
    }
  }

  async analyzePlayground(content, prompt) {
    try {
      this.initialize();
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const model = this.genAI.getGenerativeModel({ model: modelName });
      
      const musthavePrompt = `
      Return the result EXCLUSIVELY as a JSON object:  
      {
        "title": "xxxxx",
        "correspondent": "xxxxxxxx",
        "tags": ["Tag1", "Tag2"],
        "document_date": "YYYY-MM-DD",
        "language": "en/de/es/..."
      }`;

      const result = await model.generateContent([
        prompt + "\n\n" + musthavePrompt,
        content
      ]);

      const usage = result.response.usageMetadata || {};
      const metrics = {
        promptTokens: usage.promptTokenCount || 0,
        completionTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0
      };

      let jsonContent = result.response.text().replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      return {
        document: JSON.parse(jsonContent),
        metrics: metrics,
        truncated: false
      };
    } catch (error) {
      console.error('Failed to analyze playground with Gemini:', error);
      throw error;
    }
  }

  async generateText(prompt) {
    this.initialize();
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const model = this.genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  async checkStatus() {
    try {
      this.initialize();
      if (!this.genAI) throw new Error('Client not initialized');
      const model = this.genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
      await model.generateContent('Test');
      return { status: 'ok', model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' };
    } catch (error) {
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new GeminiService();
