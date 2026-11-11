const { parse, parseISO, isValid, format } = require('date-fns');

class MetadataNormalizationService {
  static normalizeAnalysisDocument(document = {}, options = {}) {
    const currentDoc = options.currentDoc || {};
    const maxTags = Number.isInteger(options.maxTags) ? options.maxTags : 4;
    const normalizedTags = this.normalizeTags(document.tags, maxTags);

    return {
      ...document,
      title: this.normalizeTitle(document.title, currentDoc.title, { normalizedTags }),
      correspondent: this.normalizeCorrespondent(document.correspondent),
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
      process.env.METADATA_KEEP_NUMERIC_TAGS || '',
      process.env.METADATA_CORRESPONDENT_ALIASES || ''
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
    const correspondentAliases = this.parseJsonObject(process.env.METADATA_CORRESPONDENT_ALIASES, 'METADATA_CORRESPONDENT_ALIASES');

    const value = {
      tagAliases: this.buildAliasMap(tagAliases),
      // Tag aliases are not applied to titles: an alias is written for a tag
      // that consists of nothing else ("1234" -> a property tag), while in a
      // title the same characters are an amount, an account ending or part
      // of somebody else's name.
      titleReplacements: this.buildTitleReplacements(titleReplacements),
      propertyTagLookups: new Set(propertyTags.map((tag) => this.normalizeForLookup(tag))),
      dropAddressTags: (process.env.METADATA_DROP_ADDRESS_TAGS || 'no').toLowerCase() === 'yes',
      dropTagLookups: new Set(dropExactTags.map((tag) => this.normalizeForLookup(tag)).filter(Boolean)),
      dropTagPatterns: this.buildPatternList(dropPatterns, 'METADATA_TAG_DROP_PATTERNS'),
      keepNumericTagLookups: new Set(keepNumericTags.map((tag) => this.normalizeForLookup(tag)).filter(Boolean)),
      correspondentAliases: this.buildAliasMap(correspondentAliases)
    };

    this._rulesCache = { signature, value };
    return value;
  }

  // Paperless matches correspondents by exact name, so a variant the model
  // writes ("Acme Mortgage Servicing LLC") would otherwise become a new
  // correspondent next to the canonical one.
  static normalizeCorrespondent(value) {
    const normalized = this.normalizeSimpleString(value);
    if (!normalized) {
      return null;
    }

    const { correspondentAliases } = this.getRules();
    return correspondentAliases.get(this.normalizeForLookup(normalized)) || normalized;
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

  // One pass over the title with every source (and every target, mapped to
  // itself) in a single longest-first alternation. Applied one after another,
  // "Jane" -> "Jane Doe" re-expanded titles that were already right
  // ("Jane Doe Doe"); a matched name is now consumed whole.
  static buildTitleReplacements(rawMap = {}) {
    const replacements = new Map();
    for (const [source, target] of Object.entries(rawMap)) {
      const normalizedSource = this.normalizeSimpleString(source);
      const normalizedTarget = this.normalizeSimpleString(target);

      if (!normalizedSource || !normalizedTarget) {
        continue;
      }

      replacements.set(normalizedSource.toLowerCase(), normalizedTarget);
      if (!replacements.has(normalizedTarget.toLowerCase())) {
        replacements.set(normalizedTarget.toLowerCase(), normalizedTarget);
      }
    }

    if (replacements.size === 0) {
      return null;
    }

    const alternation = [...replacements.keys()]
      .sort((left, right) => right.length - left.length)
      .map((source) => this.escapeRegex(source))
      .join('|');
    // A source only counts as a whole token: not inside a longer word or
    // number, and not glued to the characters that make it part of an amount,
    // an identifier, a path or an address ("$1234.00", "#1234", "1234-1").
    return {
      replacements,
      regex: new RegExp(`(?<![A-Za-z0-9$#@/_.,:-])(?:${alternation})(?![A-Za-z0-9@/_-]|[.,:]\\d)`, 'gi')
    };
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

      // A pattern that went through JSON encoding once too often arrives with
      // doubled backslashes ("\\\\s+" instead of "\\s+") and then looks for a
      // literal backslash, which no tag contains: it silently never matches.
      const pattern = normalizedPattern.replace(/\\\\(?=[A-Za-z.()[\]{}+*?^$|/-])/g, '\\');
      if (pattern !== normalizedPattern) {
        console.warn(`[WARN] Pattern "${normalizedPattern}" from ${envName} is double-escaped; using "${pattern}"`);
      }

      try {
        compiledPatterns.push(new RegExp(pattern, 'i'));
      } catch (error) {
        console.warn(`[WARN] Failed to compile pattern "${pattern}" from ${envName}: ${error.message}`);
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
    if (!titleReplacements) {
      return value;
    }

    return value.replace(
      titleReplacements.regex,
      (match, offset, whole) => {
        // A bare number in a title is nearly always an identifier ("Check
        // 1234", "Form 1234"). It is only replaced when it is a complete
        // " - " segment of the title, where it stands for the subject.
        if (/^\d+$/.test(match)) {
          const before = whole.slice(0, offset);
          const after = whole.slice(offset + match.length);
          if (!/(?:^|\s[-–—]\s)$/.test(before) || !/^(?:$|\s[-–—]\s)/.test(after)) {
            return match;
          }
        }

        return titleReplacements.replacements.get(match.toLowerCase()) || match;
      }
    );
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

  // Titles of documents about a property end in the property name instead of
  // an owner or a street address ("Water Bill 2025 - Maple Court"). A property
  // tag alone is not enough to do that: the tag is also assigned to personal
  // documents of the people living there, and those keep the person.
  static rewritePropertyTitleSuffix(title, normalizedTags = []) {
    if (!title || !Array.isArray(normalizedTags) || normalizedTags.length === 0) {
      return title;
    }

    const { propertyTagLookups, tagAliases } = this.getRules();
    if (propertyTagLookups.size === 0) {
      return title;
    }

    const propertyTags = normalizedTags.filter((tag) => propertyTagLookups.has(this.normalizeForLookup(tag)));
    if (propertyTags.length === 0) {
      return title;
    }

    const parts = title.split(/\s+-\s+/);
    if (parts.length < 2) {
      return title;
    }

    const currentSuffix = parts[parts.length - 1].trim();
    const suffixLookup = this.normalizeForLookup(currentSuffix);
    if (!suffixLookup || propertyTags.some((tag) => this.normalizeForLookup(tag) === suffixLookup)) {
      return title;
    }

    let replacement = null;
    if (this.looksLikeStreetAddress(currentSuffix)) {
      // An address is only replaced by the property it belongs to.
      const houseNumber = suffixLookup.split(' ')[0];
      replacement = propertyTags.find((tag) => {
        const tagLookup = this.normalizeForLookup(tag);
        return this.normalizeForLookup(tagAliases.get(suffixLookup)) === tagLookup
          || this.normalizeForLookup(tagAliases.get(houseNumber)) === tagLookup
          || ` ${suffixLookup} `.includes(` ${tagLookup} `);
      });
    } else if (
      this.looksLikePersonOrAddressLabel(currentSuffix)
      && this.PROPERTY_TITLE_PATTERN.test(title)
      && !this.PERSONAL_TITLE_PATTERN.test(title)
    ) {
      replacement = propertyTags[0];
    }

    if (!replacement) {
      return title;
    }

    parts[parts.length - 1] = replacement;
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
    // The candidate comes from the model and is parsed strictly; the fallback
    // is the date Paperless already has and only needs to be read.
    const parsedCandidate = this.parseStrictDate(candidateDate);
    const parsedFallback = this.parseDocumentDate(fallbackDate);

    if (this.isAcceptableDate(parsedCandidate, parsedFallback)) {
      return format(parsedCandidate, 'yyyy-MM-dd');
    }

    if (parsedFallback) {
      return format(parsedFallback, 'yyyy-MM-dd');
    }

    return null;
  }

  static formatDate(date) {
    return format(date, 'yyyy-MM-dd');
  }

  // Strict parser for dates written by the model. The lenient parser below
  // accepts bare numbers ("21" -> year 2100), reads two-digit years as the
  // year 26 and guesses the day/month order per separator. A wrong date is
  // worse than none, so anything not listed here yields null.
  static parseStrictDate(value, options = {}) {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) {
      return null;
    }

    const now = options.now instanceof Date ? options.now : new Date();
    const minYear = Number.isInteger(options.minYear) ? options.minYear : 1900;
    const maxYear = Number.isInteger(options.maxYear) ? options.maxYear : now.getFullYear() + 1;
    const dayFirst = String(options.order || process.env.AMBIGUOUS_DATE_ORDER || 'MDY').trim().toUpperCase() === 'DMY';

    let year;
    let month;
    let day;
    let match;

    if ((match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}\S*)?$/.exec(text))) {
      // The date part is taken as written; converting a timestamp to local
      // time could move it to the neighbouring day.
      [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if ((match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
      [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if ((match = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(text))) {
      const first = Number(match[1]);
      const second = Number(match[3]);
      if (first > 12 && second <= 12) {
        [day, month] = [first, second];
      } else if (second > 12 && first <= 12) {
        [month, day] = [first, second];
      } else if (dayFirst) {
        [day, month] = [first, second];
      } else {
        [month, day] = [first, second];
      }

      year = Number(match[4]);
      if (match[4].length === 2) {
        year += 2000;
        if (year > maxYear) {
          year -= 100;
        }
      }
    } else if ((match = /^(?:[A-Za-z]{3,9},? )?([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
      [month, day, year] = [this.monthNumber(match[1]), Number(match[2]), Number(match[3])];
    } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?\.? ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(text))) {
      [day, month, year] = [Number(match[1]), this.monthNumber(match[2]), Number(match[3])];
    } else {
      return null;
    }

    if (!month || year < minYear || year > maxYear) {
      return null;
    }

    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
      return null;
    }

    return parsed;
  }

  static monthNumber(name) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const lower = String(name || '').toLowerCase();
    if (lower.length < 3) {
      return null;
    }

    const index = months.findIndex((month) => month.startsWith(lower));
    return index === -1 ? null : index + 1;
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

// Words that make a title about a building rather than about a person.
MetadataNormalizationService.PROPERTY_TITLE_PATTERN = /\b(?:electric(?:ity)?|water|sewer|trash|garbage|utilit(?:y|ies)|hoa|poa|home ?owners?|property tax|real estate tax|assessment|mortgage|escrow|flood|hazard insurance|home insurance|deed|appraisal)\b/i;
// Words that make it personal even when a property word is present too.
MetadataNormalizationService.PERSONAL_TITLE_PATTERN = /\b(?:credit card|debit card|toll|vehicle|auto|car|registration|401\(?k\)?|ira|health|medical|dental|vision|w-?2|1099(?:-[a-z]+)?|1095(?:-[a-z])?|pay ?(?:stub|slip|statement)|payroll|phone|mobile|wireless|student|tuition|passport|licen[cs]e)\b/i;

module.exports = MetadataNormalizationService;
