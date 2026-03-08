const tiktoken = require('tiktoken');
const fs = require('fs').promises;
const path = require('path');
const { TextDecoder } = require('util');

function normalizeTextInput(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value == null) {
        return '';
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('utf8');
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString('utf8');
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }
    return String(value);
}

function decodeTokenizerOutput(decodedValue) {
    if (typeof decodedValue === 'string') {
        return decodedValue;
    }
    if (decodedValue instanceof Uint8Array) {
        return new TextDecoder('utf-8').decode(decodedValue);
    }
    if (ArrayBuffer.isView(decodedValue)) {
        const bytes = new Uint8Array(decodedValue.buffer, decodedValue.byteOffset, decodedValue.byteLength);
        return new TextDecoder('utf-8').decode(bytes);
    }
    if (decodedValue instanceof ArrayBuffer) {
        return new TextDecoder('utf-8').decode(new Uint8Array(decodedValue));
    }
    return normalizeTextInput(decodedValue);
}

// Map non-OpenAI models to compatible OpenAI encodings or use estimation
function getCompatibleModel(model) {
    const openaiModels = [
        // GPT-4o family
        'gpt-4o', 'chatgpt-4o-latest', 'gpt-4o-mini', 'gpt-4o-audio-preview',
        'gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview-2024-10-01',
        'gpt-4o-mini-audio-preview', 'gpt-4o-mini-audio-preview-2024-12-17',
        
        // GPT-4.1 family
        'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
        
        // GPT-3.5 family
        'gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-3.5-turbo-instruct',
        
        // GPT-4 family
        'gpt-4', 'gpt-4-32k', 'gpt-4-1106-preview', 'gpt-4-0125-preview',
        'gpt-4-turbo-2024-04-09', 'gpt-4-turbo', 'gpt-4-turbo-preview',
        
        // GPT-4.5 family
        'gpt-4.5-preview-2025-02-27', 'gpt-4.5-preview', 'gpt-4.5',
        
        // O-series models
        'o1', 'o1-2024-12-17', 'o1-preview', 'o1-mini', 'o3-mini', 'o3', 'o4-mini',
        
        // Legacy models that tiktoken might support
        'text-davinci-003', 'text-davinci-002'
    ];
    
    // If it's a known OpenAI model, return as-is
    if (openaiModels.some(openaiModel => model.includes(openaiModel))) {
        return model;
    }
    
    // For all other models (Llama, Claude, etc.), return null to use estimation
    return null;
}

// Estimate tokens for non-OpenAI models using character-based approximation
function estimateTokensForNonOpenAI(text) {
    // Rough approximation: 1 token ≈ 4 characters for most models
    // This is conservative and works reasonably well for Llama models
    return Math.ceil(text.length / 4);
}

function modelSupportsCustomTemperature(model) {
    const normalizedModel = String(model || '').trim().toLowerCase();
    if (!normalizedModel) {
        return true;
    }

    return !(
        normalizedModel.startsWith('gpt-5')
        || normalizedModel.startsWith('o1')
        || normalizedModel.startsWith('o3')
        || normalizedModel.startsWith('o4')
    );
}

function buildTemperatureOption(model, temperature) {
    return modelSupportsCustomTemperature(model) ? { temperature } : {};
}

// Calculate tokens for a given text
async function calculateTokens(text, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    const normalizedText = normalizeTextInput(text);
    try {
        const compatibleModel = getCompatibleModel(model);
        
        if (!compatibleModel) {
            // Non-OpenAI model - use character-based estimation
            console.log(`[DEBUG] Using character-based token estimation for model: ${model}`);
            return estimateTokensForNonOpenAI(normalizedText);
        }
        
        // OpenAI model - use tiktoken
        const tokenizer = tiktoken.encoding_for_model(compatibleModel);
        const tokens = tokenizer.encode(normalizedText);
        const tokenCount = tokens.length;
        tokenizer.free();
        
        return tokenCount;
        
    } catch (error) {
        console.warn(`[WARNING] Tiktoken failed for model ${model}, falling back to character estimation:`, error.message);
        return estimateTokensForNonOpenAI(normalizedText);
    }
}

// Calculate total tokens for a system prompt and additional prompts
async function calculateTotalPromptTokens(systemPrompt, additionalPrompts = [], model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    let totalTokens = 0;

    // Count tokens for system prompt
    totalTokens += await calculateTokens(systemPrompt, model);

    // Count tokens for additional prompts
    for (const prompt of additionalPrompts) {
        if (prompt) { // Only count if prompt exists
            totalTokens += await calculateTokens(prompt, model);
        }
    }

    // Add tokens for message formatting (approximately 4 tokens per message)
    const messageCount = 1 + additionalPrompts.filter(p => p).length; // Count system + valid additional prompts
    totalTokens += messageCount * 4;

    return totalTokens;
}

// Truncate text to fit within token limit
async function truncateToTokenLimit(text, maxTokens, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    const normalizedText = normalizeTextInput(text);
    try {
        const compatibleModel = getCompatibleModel(model);
        
        if (!compatibleModel) {
            // Non-OpenAI model - use character-based estimation
            console.log(`[DEBUG] Using character-based truncation for model: ${model}`);
            
            const estimatedTokens = estimateTokensForNonOpenAI(normalizedText);
            
            if (estimatedTokens <= maxTokens) {
                return normalizedText;
            }
            
            // Truncate based on character estimation (conservative approach)
            const maxChars = maxTokens * 4; // 4 chars per token approximation
            const truncatedText = normalizedText.substring(0, maxChars);
            
            // Try to break at a word boundary if possible
            const lastSpaceIndex = truncatedText.lastIndexOf(' ');
            if (lastSpaceIndex > maxChars * 0.8) { // Only if we don't lose too much text
                return truncatedText.substring(0, lastSpaceIndex);
            }
            
            return truncatedText;
        }
        
        // OpenAI model - use tiktoken
        const tokenizer = tiktoken.encoding_for_model(compatibleModel);
        const tokens = tokenizer.encode(normalizedText);
      
        if (tokens.length <= maxTokens) {
            tokenizer.free();
            return normalizedText;
        }
      
        const truncatedTokens = tokens.slice(0, maxTokens);
        const truncatedText = decodeTokenizerOutput(tokenizer.decode(truncatedTokens));
        tokenizer.free();

        return truncatedText;
        
    } catch (error) {
        console.warn(`[WARNING] Token truncation failed for model ${model}, falling back to character estimation:`, error.message);
        
        // Fallback to character-based estimation
        const estimatedTokens = estimateTokensForNonOpenAI(normalizedText);
        
        if (estimatedTokens <= maxTokens) {
            return normalizedText;
        }
        
        const maxChars = maxTokens * 4;
        const truncatedText = normalizedText.substring(0, maxChars);
        
        // Try to break at a word boundary if possible
        const lastSpaceIndex = truncatedText.lastIndexOf(' ');
        if (lastSpaceIndex > maxChars * 0.8) {
            return truncatedText.substring(0, lastSpaceIndex);
        }
        
        return truncatedText;
    }
}

// Write prompt and content to a file with size management
async function writePromptToFile(systemPrompt, truncatedContent, filePath = './logs/prompt.txt', maxSize = 10 * 1024 * 1024) {
    try {
        // Ensure the logs directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        // Check file size and manage it
        try {
            const stats = await fs.stat(filePath);
            if (stats.size > maxSize) {
                await fs.unlink(filePath); // Delete the file if it exceeds max size
                console.log(`[DEBUG] Cleared log file ${filePath} due to size limit`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('[WARNING] Error checking file size:', error);
            }
        }

        // Write the content with timestamp
        const timestamp = new Date().toISOString();
        const content = `\n=== ${timestamp} ===\nSYSTEM PROMPT:\n${systemPrompt}\n\nUSER CONTENT:\n${truncatedContent}\n\n`;
        
        await fs.appendFile(filePath, content);
    } catch (error) {
        console.error('[ERROR] Error writing to file:', error);
    }
}

module.exports = {
    calculateTokens,
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile,
    modelSupportsCustomTemperature,
    buildTemperatureOption
};
