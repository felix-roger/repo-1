'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MAX_WORD_SETS, normalizeWhitespace, sanitizeWordSets } = require('./wordValidation');

const MODEL = 'claude-haiku-4-5-20251001';
const API_TIMEOUT_MS = 8000;

const DIFFICULTY_STYLE = {
  easy: 'common, everyday two-word phrases that would be easy for an opponent to guess',
  medium: 'moderately common two-word phrases — not too obvious, but not obscure',
  hard: 'creative, less common two-word phrases that are still sensible but challenging to guess'
};

// Probability that the AI's real best guess is actually used, per difficulty.
// A rejected guess becomes a blank (guaranteed-incorrect) guess, the same as an unanswered human guess.
const GUESS_ACCEPT_PROBABILITY = { easy: 0.25, medium: 0.6, hard: 0.9 };

// Small offline fallback used only if the API key is missing or a call fails/times out,
// so a room can never hang indefinitely on a broken key or network issue.
const FALLBACK_PHRASES = [
  { first: 'GLOBAL', second: 'ECONOMY' },
  { first: 'SYSTEMIC', second: 'FAILURE' },
  { first: 'SOLAR', second: 'PANEL' },
  { first: 'QUIET', second: 'STORM' },
  { first: 'OCEAN', second: 'WAVE' },
  { first: 'PERFECT', second: 'MATCH' },
  { first: 'WORLD', second: 'VIEW' },
  { first: 'STAR', second: 'STUDDED' },
  { first: 'MEAT', second: 'MARKET' },
  { first: 'FORMULA', second: 'RACING' }
];

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

if (!apiKey) {
  console.warn('[ai] ANTHROPIC_API_KEY is not set — AI opponents will use offline fallback phrases/guesses.');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI request timed out')), ms))
  ]);
}

function extractJson(text) {
  const start = Math.min(
    ...['[', '{'].map((ch) => {
      const idx = text.indexOf(ch);
      return idx === -1 ? Infinity : idx;
    })
  );
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('No JSON found in AI response');
  return JSON.parse(text.slice(start, end + 1));
}

function fallbackPhrases(count) {
  const shuffled = [...FALLBACK_PHRASES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Asks Claude for up to MAX_WORD_SETS two-word phrases at the given difficulty,
 * avoiding phrases already used earlier this game. Falls back to a small offline
 * set on any error, missing key, or timeout.
 */
async function generateAIPhrases(difficulty, avoidPhrases) {
  if (!client) return fallbackPhrases(MAX_WORD_SETS);

  const style = DIFFICULTY_STYLE[difficulty] || DIFFICULTY_STYLE.medium;
  const avoidList = (avoidPhrases || []).map((p) => `${p.first} ${p.second}`).join(', ');

  const prompt = [
    `You are playing a word game. Come up with exactly ${MAX_WORD_SETS} two-word phrases.`,
    `Style: ${style}.`,
    'Each word must be a single real English word using only letters, hyphens, or apostrophes (no numbers or symbols).',
    avoidList ? `Do not reuse any of these phrases already used this game: ${avoidList}.` : '',
    `Respond with ONLY a JSON array, no other text, in this exact shape: [{"first":"WORD","second":"WORD"}, ...] with exactly ${MAX_WORD_SETS} entries.`
  ].filter(Boolean).join(' ');

  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      }),
      API_TIMEOUT_MS
    );

    const text = response.content.map((block) => block.text || '').join('');
    const parsed = extractJson(text);
    const cleaned = sanitizeWordSets(parsed);

    console.log(`[ai] LIVE phrases (${difficulty}) — prompt: ${prompt}`);
    console.log(`[ai] LIVE phrases (${difficulty}) — raw response: ${text}`);
    console.log(`[ai] LIVE phrases (${difficulty}) — used:`, cleaned);

    return cleaned.length > 0 ? cleaned : fallbackPhrases(MAX_WORD_SETS);
  } catch (err) {
    console.warn('[ai] generateAIPhrases failed, using fallback:', err.message);
    return fallbackPhrases(MAX_WORD_SETS);
  }
}

/**
 * Asks Claude to guess the hidden second word for each given first word, at the given
 * difficulty. Each real guess is kept only with a difficulty-based probability; rejected
 * guesses become blanks (guaranteed incorrect). Falls back to all-blank guesses on error.
 */
async function generateAIGuesses(firstWords, difficulty) {
  if (firstWords.length === 0) return [];
  if (!client) return firstWords.map(() => '');

  const acceptProbability = GUESS_ACCEPT_PROBABILITY[difficulty] ?? GUESS_ACCEPT_PROBABILITY.medium;

  const prompt = [
    'You are playing a word game. For each of the following first words, guess the single most likely',
    'second word that would complete a common two-word phrase starting with it.',
    `First words: ${firstWords.join(', ')}.`,
    'Each guess must be a single real English word using only letters, hyphens, or apostrophes.',
    `Respond with ONLY a JSON array of ${firstWords.length} strings, no other text, in the same order as the first words given, e.g. ["WORD1","WORD2"].`
  ].join(' ');

  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
      API_TIMEOUT_MS
    );

    const text = response.content.map((block) => block.text || '').join('');
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) throw new Error('AI guess response was not an array');

    const gated = firstWords.map((_, idx) => {
      const guess = normalizeWhitespace(String(parsed[idx] || ''));
      if (!guess) return '';
      return Math.random() < acceptProbability ? guess : '';
    });

    console.log(`[ai] LIVE guesses (${difficulty}) — prompt: ${prompt}`);
    console.log(`[ai] LIVE guesses (${difficulty}) — raw response: ${text}`);
    console.log(`[ai] LIVE guesses (${difficulty}) — Claude's real guesses:`, parsed, '— after difficulty gate:', gated);

    return gated;
  } catch (err) {
    console.warn('[ai] generateAIGuesses failed, using fallback:', err.message);
    return firstWords.map(() => '');
  }
}

module.exports = { generateAIPhrases, generateAIGuesses };
