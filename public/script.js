'use strict';

/* ============================================================
   THE FINAL WORD — Networked Client
   Talks to server/server.js over a WebSocket. The server is
   authoritative for game state, secrets, and timers; this file
   only renders whatever it's told and sends player actions.
   ============================================================ */

const MAX_WORD_SETS = 3;
const CLOCK_URGENT_THRESHOLD = 10;
const PHRASE_PATTERN = /^[A-Za-z'-]+$/;

/* ------------------------------------------------------------
   Client-side session state (mirrors server broadcasts)
   ------------------------------------------------------------ */

let socket = null;
let intentionalDisconnect = false;
let mySlot = null; // 'player1' | 'player2'
let roomCode = '';
let currentRound = 1;
let totalRounds = 5;
let scores = { player1: 0, player2: 0 };
let names = { player1: 'Player 1', player2: 'Player 2' };
let entryLocked = false;
let guessLocked = false;

let timerInterval = null;

/* ------------------------------------------------------------
   DOM references
   ------------------------------------------------------------ */

const screens = {
  home: document.getElementById('screen-home'),
  create: document.getElementById('screen-create'),
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  entry: document.getElementById('screen-entry'),
  guess: document.getElementById('screen-guess'),
  summary: document.getElementById('screen-summary'),
  gameover: document.getElementById('screen-gameover'),
  connectionLost: document.getElementById('screen-connection-lost')
};

const el = {
  // Home
  btnShowCreate: document.getElementById('btn-show-create'),
  btnShowJoin: document.getElementById('btn-show-join'),
  btnHowToPlay: document.getElementById('btn-how-to-play'),

  // Create
  createForm: document.getElementById('create-form'),
  createName: document.getElementById('create-name'),
  createError: document.getElementById('create-error'),
  btnCreateBack: document.getElementById('btn-create-back'),

  // Join
  joinForm: document.getElementById('join-form'),
  joinName: document.getElementById('join-name'),
  joinCode: document.getElementById('join-code'),
  joinError: document.getElementById('join-error'),
  btnJoinBack: document.getElementById('btn-join-back'),

  // Waiting
  waitingTitle: document.getElementById('waiting-title'),
  waitingRoomCodeBox: document.getElementById('waiting-room-code-box'),
  waitingRoomCode: document.getElementById('waiting-room-code'),
  waitingMessage: document.getElementById('waiting-message'),

  // Entry
  entryClock: document.getElementById('entry-clock'),
  entryHudRound: document.getElementById('entry-hud-round'),
  entryHudP1: document.getElementById('entry-hud-p1'),
  entryHudP2: document.getElementById('entry-hud-p2'),
  entryForm: document.getElementById('entry-form'),
  entryFirstInputs: document.querySelectorAll('.entry-first-input'),
  entrySecondInputs: document.querySelectorAll('.entry-second-input'),
  entryError: document.getElementById('entry-error'),

  // Guess
  guessClock: document.getElementById('guess-clock'),
  guessHudRound: document.getElementById('guess-hud-round'),
  guessHudP1: document.getElementById('guess-hud-p1'),
  guessHudP2: document.getElementById('guess-hud-p2'),
  guessOwnerName: document.getElementById('guess-owner-name'),
  guessForm: document.getElementById('guess-form'),
  guessGrid: document.getElementById('guess-grid'),

  // Summary
  summaryRoundIndicator: document.getElementById('summary-round-indicator'),
  summaryP1Label: document.getElementById('summary-p1-label'),
  summaryP2Label: document.getElementById('summary-p2-label'),
  summaryP1Phrases: document.getElementById('summary-p1-phrases'),
  summaryP2Phrases: document.getElementById('summary-p2-phrases'),
  summaryP1Guesses: document.getElementById('summary-p1-guesses'),
  summaryP2Guesses: document.getElementById('summary-p2-guesses'),
  summaryP1GuessCaption: document.getElementById('summary-p1-guess-caption'),
  summaryP2GuessCaption: document.getElementById('summary-p2-guess-caption'),
  summaryScoreLabelP1: document.getElementById('summary-score-label-p1'),
  summaryScoreLabelP2: document.getElementById('summary-score-label-p2'),
  summaryScoreP1: document.getElementById('summary-score-p1'),
  summaryScoreP2: document.getElementById('summary-score-p2'),
  btnNextRound: document.getElementById('btn-next-round'),

  // Game over
  finalLabelP1: document.getElementById('final-label-p1'),
  finalLabelP2: document.getElementById('final-label-p2'),
  finalScoreP1: document.getElementById('final-score-p1'),
  finalScoreP2: document.getElementById('final-score-p2'),
  winnerAnnouncement: document.getElementById('winner-announcement'),
  celebration: document.getElementById('celebration'),
  btnPlayAgain: document.getElementById('btn-play-again'),
  btnGameoverReset: document.getElementById('btn-gameover-reset'),
  btnGameoverHome: document.getElementById('btn-gameover-home'),

  // Connection lost
  connectionLostMessage: document.getElementById('connection-lost-message'),
  btnConnectionLostHome: document.getElementById('btn-connection-lost-home'),

  // Modals
  modalHowToPlay: document.getElementById('modal-how-to-play'),
  btnCloseHowToPlay: document.getElementById('btn-close-how-to-play'),
  modalConfirmReset: document.getElementById('modal-confirm-reset'),
  btnCancelReset: document.getElementById('btn-cancel-reset'),
  btnConfirmReset: document.getElementById('btn-confirm-reset')
};

function otherSlot(slot) {
  return slot === 'player1' ? 'player2' : 'player1';
}

/* ------------------------------------------------------------
   Screen management
   ------------------------------------------------------------ */

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
  focusFirstInput(screens[name]);
}

function focusFirstInput(container) {
  const input = container.querySelector('input');
  if (input) {
    requestAnimationFrame(() => input.focus());
  } else {
    const btn = container.querySelector('button');
    if (btn) requestAnimationFrame(() => btn.focus());
  }
}

/* ------------------------------------------------------------
   Text formatting & validation helpers
   ------------------------------------------------------------ */

function normalizeWhitespace(str) {
  return str.trim().replace(/\s+/g, ' ');
}

function toTitleCase(word) {
  return word
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

function validateSingleWord(raw) {
  const cleaned = normalizeWhitespace(raw);
  if (!cleaned) {
    return { valid: false, error: 'Please enter a word.' };
  }
  if (cleaned.includes(' ')) {
    return { valid: false, error: 'Only one word is allowed per field.' };
  }
  if (!PHRASE_PATTERN.test(cleaned)) {
    return {
      valid: false,
      error: 'Only letters, hyphens, and apostrophes are allowed — no numbers or symbols.'
    };
  }
  return { valid: true, word: cleaned.toUpperCase() };
}

/* ------------------------------------------------------------
   Countdown timer engine (driven by an absolute server endsAt)
   ------------------------------------------------------------ */

function formatClock(seconds) {
  const clamped = Math.max(seconds, 0);
  const m = Math.floor(clamped / 60).toString().padStart(2, '0');
  const s = (clamped % 60).toString().padStart(2, '0');
  return `Clock : ${m}:${s}`;
}

function renderClock(displayEl, seconds) {
  displayEl.textContent = formatClock(seconds);
  displayEl.classList.toggle('hud-clock-urgent', seconds <= CLOCK_URGENT_THRESHOLD && seconds > 0);
}

function startCountdownUntil(endsAt, displayEl, onExpire) {
  clearCountdown();
  const tick = () => {
    const secondsLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    renderClock(displayEl, secondsLeft);
    if (endsAt - Date.now() <= 0) {
      clearCountdown();
      onExpire();
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function clearCountdown() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

/* ------------------------------------------------------------
   HUD helper
   ------------------------------------------------------------ */

function updateHud(hudRoundEl, hudP1El, hudP2El) {
  hudRoundEl.textContent = `Round ${currentRound}`;
  hudP1El.textContent = `${names.player1} : ${scores.player1}`;
  hudP2El.textContent = `${names.player2} : ${scores.player2}`;
}

/* ------------------------------------------------------------
   Voice input
   ------------------------------------------------------------ */

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE_SUPPORTED = !!SpeechRecognitionCtor;

function speakWordInto(inputEl, micBtn) {
  if (!VOICE_SUPPORTED || micBtn.disabled) return;

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  micBtn.classList.add('mic-listening');

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript || '';
    const firstWord = normalizeWhitespace(transcript).split(' ')[0] || '';
    inputEl.value = firstWord;
    inputEl.focus();
  };

  recognition.onend = () => {
    micBtn.classList.remove('mic-listening');
  };

  recognition.onerror = () => {
    micBtn.classList.remove('mic-listening');
  };

  recognition.start();
}

function initVoiceButtons(container) {
  container.querySelectorAll('.mic-btn[data-target]').forEach((btn) => {
    if (!VOICE_SUPPORTED) {
      btn.disabled = true;
      btn.title = 'Voice input is not supported in this browser.';
      return;
    }
    btn.addEventListener('click', () => {
      const inputEl = document.getElementById(btn.dataset.target);
      if (inputEl) speakWordInto(inputEl, btn);
    });
  });
}

/* ------------------------------------------------------------
   WebSocket connection
   ------------------------------------------------------------ */

function connectSocket(onOpen) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    onOpen();
    return;
  }
  if (socket) {
    try {
      socket.close();
    } catch (err) {
      /* ignore */
    }
  }
  intentionalDisconnect = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', handleServerMessage);
  socket.addEventListener('close', handleSocketClose);
}

function sendMessage(type, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...(payload || {}) }));
  }
}

function handleSocketClose() {
  if (intentionalDisconnect) return;
  if (mySlot) {
    showConnectionLost('The connection to the server was lost.');
  }
}

function handleServerMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (err) {
    return;
  }

  switch (msg.type) {
    case 'room_created': return onRoomCreated(msg);
    case 'room_joined': return onRoomJoined(msg);
    case 'opponent_joined': return onOpponentJoined(msg);
    case 'error': return onServerError(msg);
    case 'start_entry': return onStartEntry(msg);
    case 'start_guess': return onStartGuess(msg);
    case 'round_summary': return onRoundSummary(msg);
    case 'game_over': return onGameOver(msg);
    case 'scores_reset': return onScoresReset(msg);
    case 'opponent_left': return onOpponentLeft();
    default: return;
  }
}

/* ------------------------------------------------------------
   Server message handlers
   ------------------------------------------------------------ */

function onRoomCreated(msg) {
  mySlot = 'player1';
  roomCode = msg.code;
  el.waitingTitle.textContent = 'Waiting for Opponent';
  el.waitingRoomCodeBox.hidden = false;
  el.waitingRoomCode.textContent = roomCode;
  el.waitingMessage.textContent = 'Share this code with your opponent. The game starts the moment they join.';
  showScreen('waiting');
}

function onRoomJoined(msg) {
  mySlot = 'player2';
  roomCode = msg.code;
  el.waitingTitle.textContent = 'Joined!';
  el.waitingRoomCodeBox.hidden = true;
  el.waitingMessage.textContent = `Connected to ${msg.opponentName}. Starting the game...`;
  showScreen('waiting');
}

function onOpponentJoined() {
  // Server immediately starts round 1 after this — nothing else to do here.
}

function onServerError(msg) {
  if (screens.join.classList.contains('active')) {
    el.joinError.textContent = msg.message;
  } else {
    el.createError.textContent = msg.message;
  }
}

function onStartEntry(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  scores = msg.scores;
  names = msg.names;
  entryLocked = false;

  clearEntryForm();
  updateHud(el.entryHudRound, el.entryHudP1, el.entryHudP2);
  showScreen('entry');
  startCountdownUntil(msg.endsAt, el.entryClock, () => finalizeEntry(true));
}

function onStartGuess(msg) {
  guessLocked = false;
  el.guessOwnerName.textContent = `${msg.opponentName}'s`;
  renderGuessGrid(msg.firstWords);
  updateHud(el.guessHudRound, el.guessHudP1, el.guessHudP2);
  showScreen('guess');
  startCountdownUntil(msg.endsAt, el.guessClock, () => finalizeGuesses());
}

function onRoundSummary(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  scores = msg.scores;
  names = msg.names;

  el.summaryRoundIndicator.textContent = `Round ${currentRound} of ${totalRounds}`;
  el.summaryP1Label.textContent = `${names.player1} Phrases`;
  el.summaryP2Label.textContent = `${names.player2} Phrases`;

  renderPhraseLines(el.summaryP1Phrases, msg.player1.phrases);
  renderPhraseLines(el.summaryP2Phrases, msg.player2.phrases);

  renderGuessNumbered(el.summaryP1Guesses, msg.player1.guessesAboutThem);
  const p1Correct = msg.player1.guessesAboutThem.filter((r) => r.correct).length;
  el.summaryP1GuessCaption.textContent = `${names.player2} guessed ${p1Correct} of ${msg.player1.guessesAboutThem.length} correctly.`;

  renderGuessNumbered(el.summaryP2Guesses, msg.player2.guessesAboutThem);
  const p2Correct = msg.player2.guessesAboutThem.filter((r) => r.correct).length;
  el.summaryP2GuessCaption.textContent = `${names.player1} guessed ${p2Correct} of ${msg.player2.guessesAboutThem.length} correctly.`;

  el.summaryScoreLabelP1.textContent = names.player1;
  el.summaryScoreLabelP2.textContent = names.player2;
  el.summaryScoreP1.textContent = scores.player1;
  el.summaryScoreP2.textContent = scores.player2;

  el.btnNextRound.disabled = false;
  el.btnNextRound.textContent = currentRound >= totalRounds ? 'See Final Results' : 'Continue to Next Round';

  showScreen('summary');
}

function onGameOver(msg) {
  scores = msg.scores;
  names = msg.names;

  el.finalLabelP1.textContent = names.player1;
  el.finalLabelP2.textContent = names.player2;
  el.finalScoreP1.textContent = scores.player1;
  el.finalScoreP2.textContent = scores.player2;

  let winnerText;
  if (msg.winner === 'player1') winnerText = `${names.player1} Wins!`;
  else if (msg.winner === 'player2') winnerText = `${names.player2} Wins!`;
  else winnerText = "It's a Draw!";
  el.winnerAnnouncement.textContent = winnerText;

  showScreen('gameover');
  playCelebration();
}

function onScoresReset(msg) {
  scores = msg.scores;
  if (screens.gameover.classList.contains('active')) {
    el.finalScoreP1.textContent = scores.player1;
    el.finalScoreP2.textContent = scores.player2;
  }
}

function onOpponentLeft() {
  showConnectionLost('Your opponent disconnected. Start a new game from the home screen.');
}

function showConnectionLost(message) {
  clearCountdown();
  el.connectionLostMessage.textContent = message;
  showScreen('connectionLost');
}

/* ------------------------------------------------------------
   Entry phase
   ------------------------------------------------------------ */

function clearEntryForm() {
  el.entryForm.reset();
  el.entryFirstInputs.forEach((input) => input.classList.remove('invalid'));
  el.entrySecondInputs.forEach((input) => input.classList.remove('invalid'));
  el.entryError.textContent = '';
}

/**
 * Reads all 3 entry rows and finalizes this player's word sets.
 * On manual submit (fromTimeout=false), a partially-filled or invalid row blocks
 * submission with an error. On timeout (fromTimeout=true), invalid/incomplete
 * rows are silently dropped and whatever is valid is sent.
 */
function finalizeEntry(fromTimeout) {
  if (entryLocked) return;

  el.entryFirstInputs.forEach((input) => input.classList.remove('invalid'));
  el.entrySecondInputs.forEach((input) => input.classList.remove('invalid'));
  el.entryError.textContent = '';

  const wordSets = [];

  for (let row = 0; row < MAX_WORD_SETS; row += 1) {
    const firstInput = el.entryFirstInputs[row];
    const secondInput = el.entrySecondInputs[row];
    const firstRaw = normalizeWhitespace(firstInput.value);
    const secondRaw = normalizeWhitespace(secondInput.value);

    if (!firstRaw && !secondRaw) {
      continue; // Row intentionally left blank — skipped.
    }

    const firstResult = validateSingleWord(firstRaw);
    const secondResult = validateSingleWord(secondRaw);

    if (firstResult.valid && secondResult.valid) {
      wordSets.push({ first: firstResult.word, second: secondResult.word });
      continue;
    }

    if (fromTimeout) {
      continue; // Silently drop incomplete/invalid rows on timeout.
    }

    el.entryError.textContent = !firstResult.valid ? firstResult.error : secondResult.error;
    (!firstResult.valid ? firstInput : secondInput).classList.add('invalid');
    return;
  }

  entryLocked = true;
  clearCountdown();
  sendMessage('submit_entry', { wordSets });

  el.waitingTitle.textContent = 'Phrases Submitted';
  el.waitingRoomCodeBox.hidden = true;
  el.waitingMessage.textContent = `Waiting for ${names[otherSlot(mySlot)]} to finish entering their phrases...`;
  showScreen('waiting');
}

/* ------------------------------------------------------------
   Guess phase
   ------------------------------------------------------------ */

function renderGuessGrid(firstWords) {
  el.guessGrid.innerHTML = '';

  firstWords.forEach((word, idx) => {
    const row = document.createElement('div');
    row.className = 'guess-row';

    const label = document.createElement('div');
    label.className = 'guess-word-label';
    label.textContent = `${toTitleCase(word)} `;
    const blank = document.createElement('span');
    blank.className = 'blank';
    blank.textContent = '______';
    label.appendChild(blank);

    const inputId = `guess-input-${idx}`;
    const srLabel = document.createElement('label');
    srLabel.className = 'sr-only';
    srLabel.setAttribute('for', inputId);
    srLabel.textContent = `Guess for word set ${idx + 1}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.className = 'guess-row-input';
    input.dataset.index = String(idx);
    input.autocomplete = 'off';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'input-with-mic';

    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'mic-btn';
    micBtn.textContent = '🎤';
    micBtn.setAttribute('aria-label', `Speak guess for word set ${idx + 1}`);
    if (!VOICE_SUPPORTED) {
      micBtn.disabled = true;
      micBtn.title = 'Voice input is not supported in this browser.';
    } else {
      micBtn.addEventListener('click', () => speakWordInto(input, micBtn));
    }

    inputWrap.appendChild(srLabel);
    inputWrap.appendChild(input);
    inputWrap.appendChild(micBtn);

    row.appendChild(label);
    row.appendChild(inputWrap);
    el.guessGrid.appendChild(row);
  });
}

/** Takes whatever is currently typed (blank guesses count as incorrect) and sends it. */
function finalizeGuesses() {
  if (guessLocked) return;
  guessLocked = true;
  clearCountdown();

  const inputs = Array.from(el.guessGrid.querySelectorAll('.guess-row-input'));
  const guesses = inputs.map((input) => normalizeWhitespace(input.value));

  sendMessage('submit_guess', { guesses });

  el.waitingTitle.textContent = 'Guesses Submitted';
  el.waitingRoomCodeBox.hidden = true;
  el.waitingMessage.textContent = `Waiting for ${names[otherSlot(mySlot)]} to finish guessing...`;
  showScreen('waiting');
}

/* ------------------------------------------------------------
   Round summary rendering
   ------------------------------------------------------------ */

function renderPhraseLines(container, phrases) {
  container.innerHTML = '';
  phrases.forEach((phrase) => {
    const line = document.createElement('span');
    line.className = 'summary-phrase';
    line.textContent = `${toTitleCase(phrase.first)} ${toTitleCase(phrase.second)}`;
    container.appendChild(line);
  });
}

function renderGuessNumbered(listEl, results) {
  listEl.innerHTML = '';
  results.forEach((result) => {
    const li = document.createElement('li');
    li.className = result.correct ? 'correct' : 'incorrect';
    li.textContent = result.guess ? toTitleCase(result.guess) : '—';
    listEl.appendChild(li);
  });
}

function playCelebration() {
  el.celebration.innerHTML = '';
  const icons = ['🎉', '✨', '🎊', '⭐', '🎉'];
  icons.forEach((icon, i) => {
    const span = document.createElement('span');
    span.textContent = icon;
    span.style.animationDelay = `${i * 0.08}s`;
    span.style.marginInline = '4px';
    el.celebration.appendChild(span);
  });
}

/* ------------------------------------------------------------
   Modals
   ------------------------------------------------------------ */

function openModal(modal) {
  modal.hidden = false;
  const focusTarget = modal.querySelector('button');
  if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
}

function closeModal(modal) {
  modal.hidden = true;
}

/* ------------------------------------------------------------
   Leaving / returning home
   ------------------------------------------------------------ */

function goHome() {
  intentionalDisconnect = true;
  clearCountdown();
  if (socket) {
    try {
      socket.close();
    } catch (err) {
      /* ignore */
    }
  }
  location.reload();
}

/* ------------------------------------------------------------
   Event wiring
   ------------------------------------------------------------ */

el.btnShowCreate.addEventListener('click', () => {
  el.createError.textContent = '';
  showScreen('create');
});
el.btnShowJoin.addEventListener('click', () => {
  el.joinError.textContent = '';
  showScreen('join');
});
el.btnHowToPlay.addEventListener('click', () => openModal(el.modalHowToPlay));
el.btnCreateBack.addEventListener('click', () => showScreen('home'));
el.btnJoinBack.addEventListener('click', () => showScreen('home'));

el.btnCloseHowToPlay.addEventListener('click', () => closeModal(el.modalHowToPlay));
el.btnCancelReset.addEventListener('click', () => closeModal(el.modalConfirmReset));
el.btnConfirmReset.addEventListener('click', () => {
  sendMessage('reset_scores');
  closeModal(el.modalConfirmReset);
});

[el.modalHowToPlay, el.modalConfirmReset].forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.modalHowToPlay.hidden) closeModal(el.modalHowToPlay);
    if (!el.modalConfirmReset.hidden) closeModal(el.modalConfirmReset);
  }
});

el.createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.createName.value;
  el.createError.textContent = '';
  connectSocket(() => sendMessage('create_room', { name }));
});

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.joinName.value;
  const code = el.joinCode.value;
  if (!normalizeWhitespace(code)) {
    el.joinError.textContent = 'Please enter a room code.';
    return;
  }
  el.joinError.textContent = '';
  connectSocket(() => sendMessage('join_room', { name, code }));
});

el.joinCode.addEventListener('input', () => {
  el.joinCode.value = el.joinCode.value.toUpperCase();
});

el.entryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  finalizeEntry(false);
});

el.guessForm.addEventListener('submit', (e) => {
  e.preventDefault();
  finalizeGuesses();
});

el.btnNextRound.addEventListener('click', () => {
  el.btnNextRound.disabled = true;
  el.btnNextRound.textContent = 'Advancing...';
  sendMessage('continue_round');
});

el.btnPlayAgain.addEventListener('click', () => sendMessage('play_again'));
el.btnGameoverReset.addEventListener('click', () => openModal(el.modalConfirmReset));
el.btnGameoverHome.addEventListener('click', goHome);
el.btnConnectionLostHome.addEventListener('click', () => location.reload());

/* ------------------------------------------------------------
   Init
   ------------------------------------------------------------ */

initVoiceButtons(el.entryForm);
showScreen('home');
