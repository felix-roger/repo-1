'use strict';

const MAX_WORD_SETS = 3;
const PHRASE_PATTERN = /^[A-Za-z'-]+$/;

function normalizeWhitespace(str) {
  return String(str || '').trim().replace(/\s+/g, ' ');
}

function validateSingleWord(raw) {
  const cleaned = normalizeWhitespace(raw);
  if (!cleaned || cleaned.includes(' ') || !PHRASE_PATTERN.test(cleaned)) return null;
  return cleaned.toUpperCase();
}

/** Filters a raw array of {first, second} down to only fully valid word sets, capped at MAX_WORD_SETS. */
function sanitizeWordSets(rawWordSets) {
  const result = [];
  if (!Array.isArray(rawWordSets)) return result;
  for (const entry of rawWordSets.slice(0, MAX_WORD_SETS)) {
    if (!entry) continue;
    const first = validateSingleWord(entry.first);
    const second = validateSingleWord(entry.second);
    if (first && second) result.push({ first, second });
  }
  return result;
}

module.exports = {
  MAX_WORD_SETS,
  PHRASE_PATTERN,
  normalizeWhitespace,
  validateSingleWord,
  sanitizeWordSets
};
