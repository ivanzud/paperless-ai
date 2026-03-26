const { parse, parseISO, isValid, format } = require('date-fns');

class MetadataNormalizationService {
  static normalizeAnalysisDocument(document = {}, options = {}) {
    const currentDoc = options.currentDoc || {};
    const maxTags = Number.isInteger(options.maxTags) ? options.maxTags : 4;
    const normalizedTags = this.normalizeTags(document.tags, maxTags);

    return {
      ...document,
      title: this.normalizeTitle(document.title, currentDoc.title, { normalizedTags }),
      correspondent: this.normalizeSimpleString(document.correspondent),
      tags: normalizedTags,
      document_type: this.normalizeSimpleString(document.document_type),
      document_date: this.normalizeDocumentDate(document.document_date, currentDoc.created),
      language: this.normalizeLanguage(document.language)
    };
  }

  static sanitizeDocumentContent(content) {
    if (typeof content !== 'string') {
      return '';
    }

    let sanitized = content.replace(/\r\n/g, '\n');
    const boilerplatePatterns = [
      /your transcription is empty\.\s*no text was detected in the image\.?/gi,
      /this image does not contain any readable text\.?/gi,
      /the image provided is too blurry(?: and (?:illegible|pixelated))? to accurately recognize any text(?: or content)?\.\s*therefore,\s*no text can be extracted from this image\.?/gi,
      /\b\d+\.\s*the image contains a series of lines with no visible text or images\.\s*it appears to be a blank or poorly parsed document\.?/gi
    ];

    for (const pattern of boilerplatePatterns) {
      sanitized = sanitized.replace(pattern, '');
    }

    return sanitized
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static hasMeaningfulAnalysis(document = {}, currentDoc = {}, options = {}) {
    const features = {
      title: true,
      tags: true,
      correspondent: true,
      documentType: true,
      customFields: true,
      date: true,
      ...options.features
    };
    const resolvedTagCount = Number.isInteger(options.resolvedTagCount)
      ? options.resolvedTagCount
      : (Array.isArray(document.tags) ? document.tags.length : 0);
    const normalizedTitle = this.normalizeSimpleString(document.title);
    const currentTitle = this.normalizeSimpleString(currentDoc.title);
    const normalizedCorrespondent = this.normalizeSimpleString(document.correspondent);
    const normalizedDocumentType = this.normalizeSimpleString(document.document_type);
    const normalizedDate = this.normalizeDocumentDate(document.document_date, currentDoc.created);
    const currentDate = this.normalizeDocumentDate(currentDoc.created, currentDoc.created);

    if (features.tags && resolvedTagCount > 0) {
      return true;
    }

    if (features.title && normalizedTitle && normalizedTitle !== currentTitle) {
      return true;
    }

    if (features.correspondent && normalizedCorrespondent) {
      return true;
    }

    if (features.documentType && normalizedDocumentType) {
      return true;
    }

    if (features.customFields && this.hasMeaningfulCustomFields(document.custom_fields)) {
      return true;
    }

    if (features.date && normalizedDate && normalizedDate !== currentDate) {
      return true;
    }

    return false;
  }

  static hasMeaningfulCustomFields(customFields) {
    if (!customFields) {
      return false;
    }

    const values = Array.isArray(customFields)
      ? customFields
      : Object.values(customFields);

    return values.some((field) => {
      if (!field || typeof field !== 'object') {
        return false;
      }

      const value = this.normalizeSimpleString(field.value);
      return Boolean(value);
    });
  }

  static getRules() {
    const signature = [
      process.env.METADATA_TAG_ALIASES || '',
      process.env.METADATA_TITLE_REPLACEMENTS || '',
      process.env.METADATA_PROPERTY_TAGS || '',
      process.env.METADATA_DROP_ADDRESS_TAGS || '',
      process.env.METADATA_TAG_DROP_EXACT || '',
      process.env.METADATA_TAG_DROP_PATTERNS || '',
      process.env.METADATA_KEEP_NUMERIC_TAGS || ''
    ].join('||');

    if (this._rulesCache?.signature === signature) {
      return this._rulesCache.value;
    }

    const tagAliases = this.parseJsonObject(process.env.METADATA_TAG_ALIASES, 'METADATA_TAG_ALIASES');
    const titleReplacements = this.parseJsonObject(process.env.METADATA_TITLE_REPLACEMENTS, 'METADATA_TITLE_REPLACEMENTS');
    const propertyTags = (process.env.METADATA_PROPERTY_TAGS || '')
      .split(',')
      .map((tag) => this.normalizeSimpleString(tag))
      .filter(Boolean);
    const dropExactTags = this.parseJsonArray(process.env.METADATA_TAG_DROP_EXACT, 'METADATA_TAG_DROP_EXACT');
    const dropPatterns = this.parseJsonArray(process.env.METADATA_TAG_DROP_PATTERNS, 'METADATA_TAG_DROP_PATTERNS');
    const keepNumericTags = this.parseJsonArray(process.env.METADATA_KEEP_NUMERIC_TAGS, 'METADATA_KEEP_NUMERIC_TAGS');

    const value = {
      tagAliases: this.buildAliasMap(tagAliases),
      titleReplacements: this.buildAliasEntries({
        ...tagAliases,
        ...titleReplacements
      }),
      propertyTagLookups: new Set(propertyTags.map((tag) => this.normalizeForLookup(tag))),
      dropAddressTags: (process.env.METADATA_DROP_ADDRESS_TAGS || 'no').toLowerCase() === 'yes',
      dropTagLookups: new Set(dropExactTags.map((tag) => this.normalizeForLookup(tag)).filter(Boolean)),
      dropTagPatterns: this.buildPatternList(dropPatterns, 'METADATA_TAG_DROP_PATTERNS'),
      keepNumericTagLookups: new Set(keepNumericTags.map((tag) => this.normalizeForLookup(tag)).filter(Boolean))
    };

    this._rulesCache = { signature, value };
    return value;
  }

  static normalizeSimpleString(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return null;
    }

    return normalized;
  }

  static normalizeForLookup(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return '';
    }

    return normalized
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static parseJsonObject(rawValue, envName) {
    if (!rawValue) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      console.warn(`[WARN] ${envName} must be a JSON object`);
    } catch (error) {
      console.warn(`[WARN] Failed to parse ${envName}: ${error.message}`);
    }

    return {};
  }

  static parseJsonArray(rawValue, envName) {
    if (!rawValue) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      console.warn(`[WARN] ${envName} must be a JSON array`);
    } catch (error) {
      console.warn(`[WARN] Failed to parse ${envName}: ${error.message}`);
    }

    return [];
  }

  static buildAliasMap(rawMap = {}) {
    const aliasMap = new Map();

    for (const [source, target] of Object.entries(rawMap)) {
      const normalizedSource = this.normalizeForLookup(source);
      const normalizedTarget = this.normalizeSimpleString(target);

      if (!normalizedSource || !normalizedTarget) {
        continue;
      }

      aliasMap.set(normalizedSource, normalizedTarget);
    }

    return aliasMap;
  }

  static buildAliasEntries(rawMap = {}) {
    return Object.entries(rawMap)
      .map(([source, target]) => {
        const normalizedSource = this.normalizeSimpleString(source);
        const normalizedTarget = this.normalizeSimpleString(target);

        if (!normalizedSource || !normalizedTarget) {
          return null;
        }

        return {
          source: normalizedSource,
          replacement: normalizedTarget,
          regex: new RegExp(this.escapeRegex(normalizedSource), 'gi')
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.source.length - left.source.length);
  }

  static escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  static buildPatternList(patterns = [], envName) {
    const compiledPatterns = [];

    for (const rawPattern of patterns) {
      const normalizedPattern = this.normalizeSimpleString(rawPattern);
      if (!normalizedPattern) {
        continue;
      }

      try {
        compiledPatterns.push(new RegExp(normalizedPattern, 'i'));
      } catch (error) {
        console.warn(`[WARN] Failed to compile pattern "${normalizedPattern}" from ${envName}: ${error.message}`);
      }
    }

    return compiledPatterns;
  }

  static looksLikeStreetAddress(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return false;
    }

    return /^\d+\s+[A-Za-z0-9#.\-]+\s+(?:[A-Za-z0-9#.\-]+\s+){0,5}(?:ave|avenue|blvd|boulevard|cir|circle|court|ct|dr|drive|hwy|highway|lane|ln|parkway|pkwy|pl|place|rd|road|st|street|terrace|ter|trail|trl|way)\b/i.test(normalized);
  }

  static smartTitleCase(value) {
    const parts = value.split(/(\s+|[-/()]+)/);
    const wordIndexes = parts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part && !/^\s+$/.test(part) && !/^[-/()]+$/.test(part) && /[A-Za-z]/.test(part))
      .map(({ index }) => index);
    const firstWordIndex = wordIndexes[0];
    const lastWordIndex = wordIndexes[wordIndexes.length - 1];
    const minorWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via']);

    return parts.map((part, index) => {
      if (!part || /^\s+$/.test(part) || /^[-/()]+$/.test(part) || !/[A-Za-z]/.test(part)) {
        return part;
      }

      if (/\d/.test(part)) {
        return part;
      }

      const lowerPart = part.toLowerCase();
      if (/^[A-Z]{2,3}$/.test(part) && !minorWords.has(lowerPart)) {
        return part;
      }

      return part
        .split("'")
        .map((segment) => {
          if (!segment) {
            return segment;
          }

          const lowerSegment = segment.toLowerCase();
          const isMinorWord = minorWords.has(lowerSegment) && index !== firstWordIndex && index !== lastWordIndex;
          if (isMinorWord) {
            return lowerSegment;
          }

          return lowerSegment.charAt(0).toUpperCase() + lowerSegment.slice(1);
        })
        .join("'");
    }).join('');
  }

  static normalizeDisplayCase(value) {
    if (!value) {
      return value;
    }

    if (!/[a-z]/.test(value) && /[A-Z]/.test(value)) {
      return this.smartTitleCase(value);
    }

    return value;
  }

  static applyTitleReplacements(value) {
    const { titleReplacements } = this.getRules();
    return titleReplacements.reduce((currentValue, entry) => {
      return currentValue.replace(entry.regex, entry.replacement);
    }, value);
  }

  static normalizeTagName(tagName) {
    const normalized = this.normalizeSimpleString(tagName);
    if (!normalized) {
      return null;
    }

    const cleaned = normalized
      .replace(/^[\-_,;:]+/, '')
      .replace(/[\-_,;:]+$/, '')
      .trim();

    if (!cleaned) {
      return null;
    }

    const rules = this.getRules();
    const {
      tagAliases,
      dropAddressTags,
      propertyTagLookups,
      keepNumericTagLookups,
      dropTagLookups,
      dropTagPatterns
    } = rules;
    const alias = tagAliases.get(this.normalizeForLookup(cleaned));
    const canonicalTag = alias || cleaned;
    const canonicalLookup = this.normalizeForLookup(canonicalTag);

    if (dropTagLookups.has(canonicalLookup)) {
      return null;
    }

    if (dropTagPatterns.some((pattern) => pattern.test(canonicalTag))) {
      return null;
    }

    if (
      this.isMonthYearLabel(canonicalTag) ||
      (
        this.isNumericTag(canonicalTag) &&
        !this.isYearTag(canonicalTag) &&
        !propertyTagLookups.has(canonicalLookup) &&
        !keepNumericTagLookups.has(canonicalLookup)
      )
    ) {
      return null;
    }

    if (dropAddressTags && this.looksLikeStreetAddress(canonicalTag)) {
      return null;
    }

    return this.normalizeDisplayCase(canonicalTag);
  }

  static isNumericTag(value) {
    const normalized = this.normalizeSimpleString(value);
    return Boolean(normalized) && /^\d{3,}$/.test(normalized);
  }

  static isYearTag(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized || !/^\d{4}$/.test(normalized)) {
      return false;
    }

    const year = Number(normalized);
    const currentYear = new Date().getFullYear();
    return year >= 1900 && year <= currentYear + 1;
  }

  static isMonthYearLabel(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return false;
    }

    return /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}$/i.test(normalized);
  }

  static looksLikePersonOrAddressLabel(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return false;
    }

    if (this.looksLikeStreetAddress(normalized) || normalized.includes('&')) {
      return true;
    }

    if (/\d/.test(normalized)) {
      return false;
    }

    const smartCased = this.normalizeDisplayCase(normalized);
    return /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(smartCased);
  }

  static rewritePropertyTitleSuffix(title, normalizedTags = []) {
    if (!title || !Array.isArray(normalizedTags) || normalizedTags.length === 0) {
      return title;
    }

    const { propertyTagLookups } = this.getRules();
    if (propertyTagLookups.size === 0) {
      return title;
    }

    const propertyAlias = normalizedTags.find((tag) => propertyTagLookups.has(this.normalizeForLookup(tag)));
    if (!propertyAlias) {
      return title;
    }

    if (!/\b(assessment|bill|invoice|loan|mortgage|notice|policy|receipt|registration|statement|tax)\b/i.test(title)) {
      return title;
    }

    const parts = title.split(/\s+-\s+/);
    if (parts.length < 2) {
      return title;
    }

    const currentSuffix = parts[parts.length - 1].trim();
    if (!currentSuffix || this.normalizeForLookup(currentSuffix) === this.normalizeForLookup(propertyAlias)) {
      return title;
    }

    if (!this.looksLikePersonOrAddressLabel(currentSuffix)) {
      return title;
    }

    parts[parts.length - 1] = propertyAlias;
    return parts.join(' - ');
  }

  static normalizeTitle(candidateTitle, fallbackTitle, options = {}) {
    const fallback = this.normalizeSimpleString(fallbackTitle);
    const normalized = this.normalizeSimpleString(candidateTitle);

    if (!normalized) {
      return fallback || null;
    }

    const cleaned = normalized
      .replace(/^title\s*[:\-]\s*/i, '')
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < 4) {
      return fallback || null;
    }

    if (/^(unknown|n\/a|null|none|untitled)$/i.test(cleaned)) {
      return fallback || null;
    }

    if (/^\[[A-Z0-9 _-]+\]$/.test(cleaned)) {
      return cleaned;
    }

    let rewritten = this.applyTitleReplacements(cleaned);

    if (!/[a-z]/.test(rewritten) && /[A-Z]/.test(rewritten)) {
      rewritten = this.smartTitleCase(rewritten);
    }

    rewritten = this.rewritePropertyTitleSuffix(rewritten, options.normalizedTags);

    return rewritten
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  static normalizeTags(tagNames, maxTags) {
    if (!Array.isArray(tagNames)) {
      return [];
    }

    const normalizedTags = [];
    const seen = new Set();

    for (const tag of tagNames) {
      const cleaned = this.normalizeTagName(tag);
      if (!cleaned) {
        continue;
      }

      const key = this.normalizeForLookup(cleaned);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalizedTags.push(cleaned);

      if (normalizedTags.length >= maxTags) {
        break;
      }
    }

    return normalizedTags;
  }

  static normalizeLanguage(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return null;
    }

    const shortCode = normalized.toLowerCase().slice(0, 8);
    return shortCode || null;
  }

  static normalizeDocumentDate(candidateDate, fallbackDate) {
    const parsedCandidate = this.parseDocumentDate(candidateDate);
    const parsedFallback = this.parseDocumentDate(fallbackDate);

    if (this.isAcceptableDate(parsedCandidate, parsedFallback)) {
      return format(parsedCandidate, 'yyyy-MM-dd');
    }

    if (parsedFallback) {
      return format(parsedFallback, 'yyyy-MM-dd');
    }

    return null;
  }

  static parseDocumentDate(value) {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const parsers = [
      () => parseISO(value),
      () => parse(value, 'yyyy-MM-dd', new Date()),
      () => parse(value, 'dd.MM.yyyy', new Date()),
      () => parse(value, 'dd-MM-yyyy', new Date()),
      () => parse(value, 'MM/dd/yyyy', new Date()),
      () => parse(value, 'yyyy/MM/dd', new Date())
    ];

    for (const parser of parsers) {
      try {
        const parsed = parser();
        if (isValid(parsed)) {
          return parsed;
        }
      } catch (error) {
        // Ignore parser errors and try the next format.
      }
    }

    return null;
  }

  static isAcceptableDate(candidateDate, fallbackDate) {
    if (!candidateDate) {
      return false;
    }

    const year = candidateDate.getFullYear();
    const currentYear = new Date().getFullYear();

    if (year < 1900 || year > currentYear + 1) {
      return false;
    }

    if (year <= 1991 && fallbackDate) {
      const fallbackYear = fallbackDate.getFullYear();
      if (fallbackYear > 1991) {
        return false;
      }
    }

    return true;
  }
}

module.exports = MetadataNormalizationService;
