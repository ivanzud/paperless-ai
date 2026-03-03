const { parse, parseISO, isValid, format } = require('date-fns');

class MetadataNormalizationService {
  static normalizeAnalysisDocument(document = {}, options = {}) {
    const currentDoc = options.currentDoc || {};
    const maxTags = Number.isInteger(options.maxTags) ? options.maxTags : 4;

    return {
      ...document,
      title: this.normalizeTitle(document.title, currentDoc.title),
      correspondent: this.normalizeSimpleString(document.correspondent),
      tags: this.normalizeTags(document.tags, maxTags),
      document_type: this.normalizeSimpleString(document.document_type),
      document_date: this.normalizeDocumentDate(document.document_date, currentDoc.created),
      language: this.normalizeLanguage(document.language)
    };
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

  static normalizeTitle(candidateTitle, fallbackTitle) {
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

    return cleaned;
  }

  static normalizeTags(tagNames, maxTags) {
    if (!Array.isArray(tagNames)) {
      return [];
    }

    const normalizedTags = [];
    const seen = new Set();

    for (const tag of tagNames) {
      const normalized = this.normalizeSimpleString(tag);
      if (!normalized) {
        continue;
      }

      const cleaned = normalized
        .replace(/^[\-_,;:]+/, '')
        .replace(/[\-_,;:]+$/, '')
        .trim();

      if (!cleaned) {
        continue;
      }

      const key = cleaned.toLowerCase();
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
