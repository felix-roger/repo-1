'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const TOTAL_ROUNDS = 5;
const MAX_WORD_SETS = 3;
const ENTRY_TIME_SECONDS = 180;
const GUESS_SECONDS_PER_WORD = 5;
const TIMEOUT_GRACE_MS = 5000;
const PHRASE_PATTERN = /^[A-Za-z'-]+$/;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** roomCode -> room state. Everything secret (second words, in-progress guesses) lives only here. */
const rooms = new Map();

function normalizeWhitespace(str) {
  return String(str || '').trim().replace(/\s+/g, ' ');
}

function validateSingleWord(raw) {
  const cleaned = normalizeWhitespace(raw);
  if (!cleaned || cleaned.includes(' ') || !PHRASE_PATTERN.test(cleaned)) return null;
  return cleaned.toUpperCase();
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function otherSlot(slot) {
  return slot === 'player1' ? 'player2' : 'player1';
}

function send(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payloadFor) {
  ['player1', 'player2'].forEach((slot) => {
    const player = room.players[slot];
    if (player.ws) {
      const payload = typeof payloadFor === 'function' ? payloadFor(slot) : payloadFor;
      send(player.ws, type, payload);
    }
  });
}

function roomNames(room) {
  return { player1: room.players.player1.name, player2: room.players.player2.name };
}

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

function createRoom() {
  const code = generateRoomCode();
  const room = {
    code,
    totalRounds: TOTAL_ROUNDS,
    currentRound: 1,
    scores: { player1: 0, player2: 0 },
    players: {
      player1: { ws: null, name: 'Player 1', connected: false },
      player2: { ws: null, name: 'Player 2', connected: false }
    },
    phase: 'lobby',
    entry: null,
    guess: null,
    entryTimer: null,
    guessTimers: { player1: null, player2: null },
    advancing: false
  };
  rooms.set(code, room);
  return room;
}

function startEntryPhase(room) {
  room.phase = 'entry';
  room.entry = {
    player1: { submitted: false, wordSets: [] },
    player2: { submitted: false, wordSets: [] },
    endsAt: Date.now() + ENTRY_TIME_SECONDS * 1000
  };
  clearTimeout(room.entryTimer);
  room.entryTimer = setTimeout(() => forceFinalizeEntry(room), ENTRY_TIME_SECONDS * 1000 + TIMEOUT_GRACE_MS);

  broadcast(room, 'start_entry', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
    endsAt: room.entry.endsAt,
    scores: room.scores,
    names: roomNames(room)
  });
}

function forceFinalizeEntry(room) {
  if (room.phase !== 'entry') return;
  ['player1', 'player2'].forEach((slot) => {
    if (!room.entry[slot].submitted) {
      room.entry[slot].submitted = true;
      room.entry[slot].wordSets = [];
    }
  });
  maybeStartGuessPhase(room);
}

function maybeStartGuessPhase(room) {
  if (room.phase !== 'entry') return;
  if (!room.entry.player1.submitted || !room.entry.player2.submitted) return;
  clearTimeout(room.entryTimer);
  startGuessPhase(room);
}

function startGuessPhase(room) {
  room.phase = 'guess';
  room.guess = {
    player1: { submitted: false, guesses: [] },
    player2: { submitted: false, guesses: [] }
  };

  ['player1', 'player2'].forEach((slot) => {
    const wordCount = room.entry[otherSlot(slot)].wordSets.length;
    const durationMs = wordCount * GUESS_SECONDS_PER_WORD * 1000;

    clearTimeout(room.guessTimers[slot]);
    room.guessTimers[slot] = setTimeout(() => forceFinalizeGuessSlot(room, slot), durationMs + TIMEOUT_GRACE_MS);

    send(room.players[slot].ws, 'start_guess', {
      round: room.currentRound,
      secondsPerWord: GUESS_SECONDS_PER_WORD,
      opponentName: room.players[otherSlot(slot)].name,
      firstWords: room.entry[otherSlot(slot)].wordSets.map((w) => w.first)
    });
  });
}

function forceFinalizeGuessSlot(room, slot) {
  if (room.phase !== 'guess' || room.guess[slot].submitted) return;
  room.guess[slot].submitted = true;
  room.guess[slot].guesses = [];
  maybeComputeResults(room);
}

function maybeComputeResults(room) {
  if (room.phase !== 'guess') return;
  if (!room.guess.player1.submitted || !room.guess.player2.submitted) return;
  clearTimeout(room.guessTimers.player1);
  clearTimeout(room.guessTimers.player2);
  computeRoundResults(room);
}

function computeRoundResults(room) {
  const results = { player1: [], player2: [] };

  room.entry.player2.wordSets.forEach((phrase, idx) => {
    const guess = (room.guess.player1.guesses[idx] || '').toUpperCase();
    results.player1.push({ guess, correct: guess.length > 0 && guess === phrase.second });
  });
  room.entry.player1.wordSets.forEach((phrase, idx) => {
    const guess = (room.guess.player2.guesses[idx] || '').toUpperCase();
    results.player2.push({ guess, correct: guess.length > 0 && guess === phrase.second });
  });

  // A correct guess awards the point to the phrase's owner, not the guesser.
  room.scores.player2 += results.player1.filter((r) => r.correct).length;
  room.scores.player1 += results.player2.filter((r) => r.correct).length;
  room.phase = 'summary';
  room.advancing = false;

  broadcast(room, 'round_summary', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
    scores: room.scores,
    names: roomNames(room),
    player1: { phrases: room.entry.player1.wordSets, guessesAboutThem: results.player2 },
    player2: { phrases: room.entry.player2.wordSets, guessesAboutThem: results.player1 }
  });
}

function advanceRound(room) {
  if (room.phase !== 'summary' || room.advancing) return;
  room.advancing = true;

  if (room.currentRound >= room.totalRounds) {
    room.phase = 'gameover';
    let winner = 'draw';
    if (room.scores.player1 > room.scores.player2) winner = 'player1';
    else if (room.scores.player2 > room.scores.player1) winner = 'player2';

    broadcast(room, 'game_over', {
      scores: room.scores,
      names: roomNames(room),
      winner
    });
    return;
  }

  room.currentRound += 1;
  startEntryPhase(room);
}

function handlePlayAgain(room) {
  if (room.phase !== 'gameover') return;
  room.currentRound = 1;
  startEntryPhase(room);
}

function handleResetScores(room) {
  room.scores.player1 = 0;
  room.scores.player2 = 0;
  broadcast(room, 'scores_reset', { scores: room.scores });
}

function cleanupRoom(room) {
  clearTimeout(room.entryTimer);
  clearTimeout(room.guessTimers.player1);
  clearTimeout(room.guessTimers.player2);
  rooms.delete(room.code);
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.slot = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type } = msg;

    if (type === 'create_room') {
      const room = createRoom();
      const name = normalizeWhitespace(msg.name).slice(0, 20) || 'Player 1';
      room.players.player1 = { ws, name, connected: true };
      ws.roomCode = room.code;
      ws.slot = 'player1';
      send(ws, 'room_created', { code: room.code, you: 'player1', name });
      return;
    }

    if (type === 'join_room') {
      const code = normalizeWhitespace(msg.code).toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, 'error', { message: 'Room not found. Check the code and try again.' });
        return;
      }
      if (room.players.player2.connected) {
        send(ws, 'error', { message: 'That room is already full.' });
        return;
      }
      const name = normalizeWhitespace(msg.name).slice(0, 20) || 'Player 2';
      room.players.player2 = { ws, name, connected: true };
      ws.roomCode = room.code;
      ws.slot = 'player2';

      send(ws, 'room_joined', { code: room.code, you: 'player2', name, opponentName: room.players.player1.name });
      send(room.players.player1.ws, 'opponent_joined', { name });

      startEntryPhase(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room || !ws.slot) return;
    const slot = ws.slot;

    if (type === 'submit_entry' && room.phase === 'entry' && !room.entry[slot].submitted) {
      room.entry[slot].submitted = true;
      room.entry[slot].wordSets = sanitizeWordSets(msg.wordSets);
      maybeStartGuessPhase(room);
      return;
    }

    if (type === 'submit_guess' && room.phase === 'guess' && !room.guess[slot].submitted) {
      const expectedCount = room.entry[otherSlot(slot)].wordSets.length;
      const guesses = Array.isArray(msg.guesses) ? msg.guesses.slice(0, expectedCount) : [];
      room.guess[slot].submitted = true;
      room.guess[slot].guesses = guesses.map((g) => normalizeWhitespace(g).toUpperCase());
      maybeComputeResults(room);
      return;
    }

    if (type === 'continue_round') {
      advanceRound(room);
      return;
    }

    if (type === 'play_again') {
      handlePlayAgain(room);
      return;
    }

    if (type === 'reset_scores') {
      handleResetScores(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.slot) return;
    room.players[ws.slot].connected = false;
    room.players[ws.slot].ws = null;
    const opponent = room.players[otherSlot(ws.slot)];
    if (opponent.ws) {
      send(opponent.ws, 'opponent_left', {});
    }
    cleanupRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`THE FINAL WORD server listening on port ${PORT}`);
});
