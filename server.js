const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const metadataNormalizationService = require('./services/metadataNormalizationService');
const documentModel = require('./models/document');
const setupService = require('./services/setupService');
const setupRoutes = require('./routes/setup');

// Add environment variables for RAG service if not already set
process.env.RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
process.env.RAG_SERVICE_ENABLED = process.env.RAG_SERVICE_ENABLED || 'true';
const cors = require('cors');
const cookieParser = require('cookie-parser');
const Logger = require('./services/loggerService');
const { max } = require('date-fns');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

const htmlLogger = new Logger({
  logFile: 'logs.html',
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const app = express();
let runningTask = false;

function getBlockingTagNames() {
  return (process.env.BLOCK_SCAN_WHEN_TAGS_PRESENT || '')
    .split(',')
    .map((tagName) => tagName.trim())
    .filter(Boolean);
}

async function getActiveScanBlockers() {
  const tagNames = getBlockingTagNames();
  if (tagNames.length === 0) {
    return [];
  }

  const counts = await paperlessService.getBlockingTagCounts(tagNames);
  return counts.filter((entry) => entry.count > 0);
}

function formatScanBlockerMessage(blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) {
    return '';
  }

  return blockers
    .map((blocker) => `${blocker.name}=${blocker.count}`)
    .join(', ');
}


const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'x-api-key',
    'Access-Control-Allow-Private-Network'
  ],
  credentials: false
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Access-Control-Allow-Private-Network');
  res.header('Access-Control-Allow-Private-Network', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

function sendOpenApiSpec(res) {
  const openApiPath = path.join(process.cwd(), 'OPENAPI', 'openapi.json');
  res.setHeader('Content-Type', 'application/json');

  // Try to serve the static file first
  fs.readFile(openApiPath)
    .then(data => {
      res.send(JSON.parse(data));
    })
    .catch(err => {
      console.warn('Error reading OpenAPI file, generating dynamically:', err.message);
      // Fallback to generating the spec if file can't be read
      res.send(swaggerSpec);
    });
}

/**
 * @swagger
 * /api-docs/openapi.json:
 *   get:
 *     summary: Retrieve the OpenAPI specification
 *     description: |
 *       Returns the complete OpenAPI specification for the Paperless-AI API.
 *       This endpoint attempts to serve a static OpenAPI JSON file first, falling back
 *       to dynamically generating the specification if the file cannot be read.
 *       
 *       The OpenAPI specification document contains all API endpoints, parameters,
 *       request bodies, responses, and schemas for the entire application.
 *     tags: [API, System]
 *     responses:
 *       200:
 *         description: OpenAPI specification returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: The complete OpenAPI specification
 *       404:
 *         description: OpenAPI specification file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error occurred while retrieving the OpenAPI specification
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/api-docs/openapi.json', (req, res) => sendOpenApiSpec(res));

// Add a redirect for the old endpoint for backward compatibility
app.get('/api-docs.json', (req, res) => {
  sendOpenApiSpec(res);
});

// Swagger documentation route (mounted after JSON endpoints)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  swaggerOptions: {
    url: '/api-docs/openapi.json'
  }
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// //Layout middleware
// app.use((req, res, next) => {
//   const originalRender = res.render;
//   res.render = function (view, locals = {}) {
//     originalRender.call(this, view, locals, (err, html) => {
//       if (err) return next(err);
//       originalRender.call(this, 'layout', { content: html, ...locals });
//     });
//   };
//   next();
// });


// Initialize data directory
async function initializeDataDirectory() {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    await fs.access(dataDir);
  } catch {
    console.log('Creating data directory...');
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Save OpenAPI specification to file
async function saveOpenApiSpec() {
  const openApiDir = path.join(process.cwd(), 'OPENAPI');
  const openApiPath = path.join(openApiDir, 'openapi.json');
  try {
    // Ensure the directory exists
    try {
      await fs.access(openApiDir);
    } catch {
      console.log('Creating OPENAPI directory...');
      await fs.mkdir(openApiDir, { recursive: true });
    }
    
    // Write the specification to file
    await fs.writeFile(openApiPath, JSON.stringify(swaggerSpec, null, 2));
    console.log(`OpenAPI specification saved to ${openApiPath}`);
    return true;
  } catch (error) {
    console.error('Failed to save OpenAPI specification:', error);
    return false;
  }
}

// Document processing functions
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id, doc.checksum);
  if (isProcessed) return null;
  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  try {
    //Check if the Document can be edited
    const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
    if (!documentEditable) {
      console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
      console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
      await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
      return null;
    }else {
      console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
    }

    let [content, originalData] = await Promise.all([
      paperlessService.getDocumentContent(doc.id),
      paperlessService.getDocument(doc.id)
    ]);

    content = metadataNormalizationService.sanitizeDocumentContent(content);

    if (!content || content.length < 10) {
      console.log(`[DEBUG] Document ${doc.id} has no content, skipping analysis`);
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      return null;
    }

    if (content.length > 50000) {
      content = content.substring(0, 50000);
    }

    const aiService = AIServiceFactory.getService();
    const analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id);
    console.log('Repsonse from AI service:', analysis);
    if (analysis.warnings?.length) {
      console.warn(`[WARNING] Document ${doc.id} analyzed with partial chunk failures:`, analysis.warnings);
    }
    if (analysis.error) {
      console.error(`[ERROR] Detailed analysis error for document ${doc.id}:`, {
        message: analysis.error,
        details: analysis.errorDetails || null,
        warnings: analysis.warnings || []
      });
      throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
    }
    await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
    return { analysis, originalData };
  } catch (error) {
    await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
    throw error;
  }
}

async function buildUpdateData(analysis, doc, existingTags = [], existingDocumentTypes = []) {
  const updateData = {};
  const normalizedDocument = metadataNormalizationService.normalizeAnalysisDocument(
    analysis?.document || {},
    { currentDoc: doc, maxTags: 4 }
  );
  let resolvedAnalysisTagIds = [];
  let allTagsToProcess = [];

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    let aiTags = normalizedDocument.tags || [];
    
    // Handle cases where Gemini returns a comma-separated string instead of an array
    if (!Array.isArray(aiTags)) {
      if (typeof aiTags === 'string') {
        aiTags = aiTags.split(',').map(tag => tag.trim()).filter(tag => tag);
      } else {
        aiTags = [];
      }
    }
    
    // Add the AI generated tags to our list
    allTagsToProcess = allTagsToProcess.concat(aiTags);
	
    // Also check if we should add the default "AI Processed" tag(s) with a safe string comparison
    const addProcessedTag = String(config.addAIProcessedTag).trim().toLowerCase();
    if (addProcessedTag === 'yes' && config.addAIProcessedTags) {
      console.log('[DEBUG] Adding default AI processed tags alongside AI generated tags');
      const defaultTags = String(config.addAIProcessedTags).split(',').map(tag => tag.trim()).filter(tag => tag);
      allTagsToProcess = allTagsToProcess.concat(defaultTags);
    }

    const { tagIds, errors } = await paperlessService.processTags(allTagsToProcess, {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      existingTags
    });
    resolvedAnalysisTagIds = tagIds;
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && String(config.addAIProcessedTag).trim().toLowerCase() === 'yes') {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = String(config.addAIProcessedTags).split(',').map(tag => tag.trim()).filter(tag => tag);
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  // Only process title if title generation is activated
  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = normalizedDocument.title || doc.title;
  }

  // Add created date regardless of settings as it's a core field
  updateData.created = normalizedDocument.document_date || doc.created;

  // Only process document type if document type classification is activated
  if (config.limitFunctions?.activateDocumentType !== 'no' && normalizedDocument.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(normalizedDocument.document_type, {
        restrictToExistingDocumentTypes: config.restrictToExistingDocumentTypes === 'yes',
        existingDocumentTypes
      });
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }
  
  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && normalizedDocument.custom_fields) {
    const customFields = normalizedDocument.custom_fields;
    const processedFields = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];
      if (!customField || typeof customField !== 'object' || Array.isArray(customField)) {
        console.log(`[DEBUG] Skipping malformed custom field metadata for key "${key}"`);
        continue;
      }

      const normalizedFieldName = typeof customField.field_name === 'string'
        ? customField.field_name.trim()
        : '';
      let normalizedFieldValue = typeof customField.value === 'string'
        ? customField.value.trim()
        : customField.value;

      if (
        !normalizedFieldName ||
        normalizedFieldValue === undefined ||
        normalizedFieldValue === null ||
        (typeof normalizedFieldValue === 'string' && !normalizedFieldValue)
      ) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      if (typeof normalizedFieldValue === 'string' && normalizedFieldValue.length > 128) {
        normalizedFieldValue = normalizedFieldValue.substring(0, 128);
        console.warn(`[WARN] Truncated custom field "${normalizedFieldName}" to 128 characters for document ${doc.id}`);
      }

      const fieldDetails = await paperlessService.findExistingCustomField(normalizedFieldName);
      if (fieldDetails?.id) {
        processedFields.push({
          field: fieldDetails.id,
          value: normalizedFieldValue
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    // Then add any existing fields that weren't updated
    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
  }

  // Only process correspondent if correspondent detection is activated
  if (config.limitFunctions?.activateCorrespondents !== 'no' && normalizedDocument.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(normalizedDocument.correspondent, {
        restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes'
      });
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  // Always include language if provided as it's a core field
  if (normalizedDocument.language) {
    updateData.language = normalizedDocument.language;
  }

  if (analysis.document.notes && typeof analysis.document.notes === 'string') {
    const trimmedNotes = analysis.document.notes.trim();
    if (trimmedNotes.length > 0) {
      updateData.notes = trimmedNotes;
    }
  }

  let resolvedTagCount = resolvedAnalysisTagIds.length;
  if (process.env.ADD_AI_PROCESSED_TAG === 'yes' && process.env.AI_PROCESSED_TAG_NAME) {
    const aiProcessedTag = await paperlessService.findExistingTag(process.env.AI_PROCESSED_TAG_NAME);
    if (aiProcessedTag?.id) {
      resolvedTagCount = resolvedAnalysisTagIds.filter((tagId) => tagId !== aiProcessedTag.id).length;
    }
  }

  const hasMeaningfulUpdate = metadataNormalizationService.hasMeaningfulAnalysis(
    normalizedDocument,
    doc,
    {
      resolvedTagCount,
      features: {
        title: config.limitFunctions?.activateTitle !== 'no',
        tags: config.limitFunctions?.activateTagging !== 'no',
        correspondent: config.limitFunctions?.activateCorrespondents !== 'no',
        documentType: config.limitFunctions?.activateDocumentType !== 'no',
        customFields: config.limitFunctions?.activateCustomFields !== 'no',
        date: true
      }
    }
  );

  if (!hasMeaningfulUpdate) {
    throw new Error('[ERROR] AI returned no actionable metadata');
  }

  return updateData;
}

async function saveDocumentChanges(docId, updateData, analysis, originalData) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;

  await Promise.all([
    documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle, null),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title, originalData.checksum),
    documentModel.addOpenAIMetrics(
      docId, 
      analysis.metrics.promptTokens,
      analysis.metrics.completionTokens,
      analysis.metrics.totalTokens
    ),
    documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent, updateData.notes ?? null)
  ]);
}

// Main scanning functions
async function scanInitial() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('[ERROR] Setup not completed. Skipping document scan.');
      return;
    }

    const blockers = await getActiveScanBlockers();
    if (blockers.length > 0) {
      console.log(`[INFO] Skipping initial scan because blocker tags still have queued documents: ${formatScanBlockerMessage(blockers)}`);
      return;
    }

    let [existingTags, documents, ownUserId, existingCorrespondentList, existingDocumentTypes] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames()
    ]);
    //get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);
    let existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);
    
    // Extract tag names from tag objects
    const existingTagNames = existingTags.map(tag => tag.name);

    for (const doc of documents) {
      try {
        const result = await processDocument(doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc, existingTagNames, existingDocumentTypesList);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
        if (error?.stack) {
          console.error(`[ERROR] processing document ${doc.id} stack:`, error.stack);
        }
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      }
    }
  } catch (error) {
    console.error('[ERROR] during initial document scan:', error);
  }
}

async function scanDocuments() {
  if (runningTask) {
    console.log('[DEBUG] Task already running');
    return;
  }

  runningTask = true;
  try {
    const blockers = await getActiveScanBlockers();
    if (blockers.length > 0) {
      console.log(`[INFO] Skipping document scan because blocker tags still have queued documents: ${formatScanBlockerMessage(blockers)}`);
      return;
    }

    let [existingTags, documents, ownUserId, existingCorrespondentList, existingDocumentTypes] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames()
    ]);

    //get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);
    
    //get existing document types list
    let existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);
    
    // Extract tag names from tag objects
    const existingTagNames = existingTags.map(tag => tag.name);

    for (const doc of documents) {
      try {
        const result = await processDocument(doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc, existingTagNames, existingDocumentTypesList);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
        if (error?.stack) {
          console.error(`[ERROR] processing document ${doc.id} stack:`, error.stack);
        }
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      }
    }
  } catch (error) {
    console.error('[ERROR]  during document scan:', error);
  } finally {
    runningTask = false;
    console.log('[INFO] Task completed');
  }
}

// Routes
app.use('/', setupRoutes);
const authRoutes = require('./routes/auth');
const ragRoutes = require('./routes/rag');

// Mount RAG routes if enabled
if (process.env.RAG_SERVICE_ENABLED === 'true') {
  app.use('/api/rag', ragRoutes);
  
  // RAG UI route
  app.get('/rag', async (req, res) => {
    try {
      res.render('rag', { 
        title: 'Dokumenten-Fragen'
      });
    } catch (error) {
      console.error('Error rendering RAG UI:', error);
      res.status(500).send('Error loading RAG interface');
    }
  });
}

/**
 * @swagger
 * /:
 *   get:
 *     summary: Root endpoint that redirects to the dashboard
 *     description: |
 *       This endpoint serves as the entry point for the application.
 *       When accessed, it automatically redirects the user to the dashboard page.
 *       No parameters or authentication are required for this redirection.
 *     tags: [Navigation, System]
 *     responses:
 *       302:
 *         description: Redirects to the dashboard page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               example: "<html><body>Redirecting to dashboard...</body></html>"
 *       500:
 *         description: Server error occurred during redirection
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/', async (req, res) => {
  try {
    res.redirect('/dashboard');
  } catch (error) {
    console.error('[ERROR] in root route:', error);
    res.status(500).send('Error processing request');
  }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Checks if the application is properly configured and the database is reachable.
 *       This endpoint can be used by monitoring systems to verify service health.
 *       
 *       The endpoint returns a 200 status code with a "healthy" status if everything is 
 *       working correctly, or a 503 status code with error details if there are issues.
 *     tags: [System]
 *     responses:
 *       200:
 *         description: System is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "healthy"
 *                   description: Health status indication
 *       503:
 *         description: System is not fully configured or database is unreachable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [not_configured, error]
 *                   example: "not_configured"
 *                   description: Error status type
 *                 message:
 *                   type: string
 *                   example: "Application setup not completed"
 *                   description: Detailed error message
 */
app.get('/health', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ 
        status: 'not_configured',
        message: 'Application setup not completed'
      });
    }

    await documentModel.isDocumentProcessed(1);
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start scanning
async function startScanning() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    console.log('Configured scan interval:', config.scanInterval);
    console.log(`Starting initial scan at ${new Date().toISOString()}`);
    if(config.disableAutomaticProcessing != 'yes') {
      await scanInitial();
  
      cron.schedule(config.scanInterval, async () => {
        console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
        await scanDocuments();
      });
    }
  } catch (error) {
    console.error('[ERROR] in startScanning:', error);
  }
}

// Error handlers
// process.on('SIGTERM', async () => {
//   console.log('Received SIGTERM. Starting graceful shutdown...');
//   try {
//     console.log('Closing database...');
//     await documentModel.closeDatabase(); // Jetzt warten wir wirklich auf den Close
//     console.log('Database closed successfully');
//     process.exit(0);
//   } catch (error) {
//     console.error('[ERROR] during shutdown:', error);
//     process.exit(1);
//   }
// });

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`[DEBUG] Received ${signal} signal. Starting graceful shutdown...`);
  try {
    console.log('[DEBUG] Closing database...');
    await documentModel.closeDatabase();
    console.log('[DEBUG] Database closed successfully');
    process.exit(0);
  } catch (error) {
    console.error(`[ERROR] during ${signal} shutdown:`, error);
    process.exit(1);
  }
}

// Handle both SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  const port = process.env.PAPERLESS_AI_PORT || 3000;
  try {
    await initializeDataDirectory();
    await saveOpenApiSpec(); // Save OpenAPI specification on startup
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      startScanning();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
