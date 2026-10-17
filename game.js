/**
 * Miku Chess Royale — Real-Time WebSocket Multiplayer, Minimax AI Bot,
 * Interactive 8x8 Grid, and Web Audio Synthesized Sound Effects.
 */

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}

// ---------------------------------------------------------------------------
// 1. Web Audio API Chess Sound Synthesizer
// ---------------------------------------------------------------------------
class ChessSoundEngine {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  _init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  haptic(style = "light") {
    try {
      if (tg && tg.HapticFeedback) {
        if (["success", "warning", "error"].includes(style)) {
          tg.HapticFeedback.notificationOccurred(style);
        } else {
          tg.HapticFeedback.impactOccurred(style);
        }
      }
    } catch (_) {}
  }

  tone(freq, duration, type = "sine", vol = 0.2, delay = 0, slideTo = null) {
    if (!this.enabled) return;
    this._init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    }

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playSelect() {
    this.haptic("light");
    this.tone(520, 0.045, "sine", 0.12);
  }

  playMove() {
    this.haptic("light");
    // Wooden chess piece placement thud
    this.tone(260, 0.075, "triangle", 0.24, 0, 140);
  }

  playCapture() {
    this.haptic("heavy");
    // Sharp capture snap + bass punch
    this.tone(580, 0.12, "sawtooth", 0.24, 0, 130);
    this.tone(150, 0.22, "square", 0.25, 0.05, 55);
  }

  playCheck() {
    this.haptic("warning");
    // Urgent double alert chime
    this.tone(880, 0.14, "triangle", 0.26, 0);
    this.tone(659.25, 0.22, "triangle", 0.26, 0.14);
  }

  playCastle() {
    this.haptic("medium");
    this.tone(330, 0.08, "triangle", 0.22, 0);
    this.tone(440, 0.12, "triangle", 0.22, 0.09);
  }

  playWin() {
    this.haptic("success");
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
    const delays = [0, 0.12, 0.24, 0.36, 0.52, 0.66];
    notes.forEach((f, i) => {
      this.tone(f, i === 5 ? 0.5 : 0.15, "triangle", 0.28, delays[i]);
    });
  }
}

const sfx = new ChessSoundEngine();

// ---------------------------------------------------------------------------
// 2. Constants & URL Identity Setup
// ---------------------------------------------------------------------------
const PIECE_GLYPHS = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const urlParams = new URLSearchParams(window.location.search);
const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;

const MY_USER_ID = Number(
  urlParams.get("user_id") ||
  urlParams.get("userId") ||
  (tgUser && tgUser.id) ||
  Math.floor(100000 + Math.random() * 899999)
);
const MY_NAME =
  urlParams.get("name") ||
  (tgUser ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") : "Player");
const MY_USERNAME = urlParams.get("username") || (tgUser && tgUser.username) || "";
const ROOM_ID = (urlParams.get("room") || "CHESS01").toUpperCase();
const BACKEND_PARAM = (urlParams.get("backend") || localStorage.getItem("miku_chess_backend") || "").replace(/\/$/, "");
if (BACKEND_PARAM) {
  localStorage.setItem("miku_chess_backend", BACKEND_PARAM);
}

document.getElementById("roomCodeLabel").textContent = ROOM_ID;

const chess = new Chess();
let myColor = "w"; // 'w' | 'b'
let isFlipped = false;
let selectedSquare = null;
let legalMovesForSelected = [];
let lastMove = null; // { from, to }
let vsAiMode = false;
let gameEnded = false;

let roomState = {
  room_id: ROOM_ID,
  status: "waiting",
  white: { user_id: MY_USER_ID, name: MY_NAME },
  black: null,
  winner: null,
  reason: "",
};

// ---------------------------------------------------------------------------
// 3. WebSocket Connection & Sync
// ---------------------------------------------------------------------------
let ws = null;
let isOnline = false;

function getWsUrl() {
  if (BACKEND_PARAM) {
    const proto = BACKEND_PARAM.startsWith("https") ? "wss://" : "ws://";
    const host = BACKEND_PARAM.replace(/^https?:\/\//, "");
    return `${proto}${host}/ws/chess/${ROOM_ID}`;
  }
  const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
  return `${proto}${window.location.host}/ws/chess/${ROOM_ID}`;
}

function connectWebSocket() {
  try {
    ws = new WebSocket(getWsUrl());
  } catch (_) {
    updateConnBadge(false);
    return;
  }

  ws.onopen = () => {
    isOnline = true;
    updateConnBadge(true);
    wsSend({
      action: "join",
      user_id: MY_USER_ID,
      name: MY_NAME,
      username: MY_USERNAME,
    });
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.emoji_floating) {
        spawnFloatingEmoji(msg.emoji_floating.emoji);
      }
      if (msg.type === "state" && msg.state) {
        applyServerState(msg.state, msg.last_move || null);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onclose = () => {
    isOnline = false;
    updateConnBadge(false);
    setTimeout(connectWebSocket, 4000);
  };
}

function updateConnBadge(online) {
  const dot = document.getElementById("connDot");
  const txt = document.getElementById("connText");
  dot.className = online ? "conn-dot online" : "conn-dot offline";
  txt.textContent = online ? "Live Server" : "Local/AI Mode";
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...payload, user_id: MY_USER_ID, name: MY_NAME }));
    return true;
  }
  return false;
}

function applyServerState(state, moveInfo) {
  roomState = state;
  vsAiMode = Boolean(state.black && state.black.is_ai);

  if (state.white && Number(state.white.user_id) === MY_USER_ID) {
    myColor = "w";
    isFlipped = false;
  } else if (state.black && Number(state.black.user_id) === MY_USER_ID) {
    myColor = "b";
    isFlipped = true;
  }

  if (state.fen && state.fen !== "start" && state.fen !== chess.fen()) {
    chess.load(state.fen);
  } else if (state.fen === "start") {
    chess.reset();
    lastMove = null;
    gameEnded = false;
  }

  if (moveInfo) {
    lastMove = { from: moveInfo.from, to: moveInfo.to };
    if (chess.in_checkmate() || state.status === "finished") {
      sfx.playWin();
    } else if (chess.in_check()) {
      sfx.playCheck();
    } else if (moveInfo.captured) {
      sfx.playCapture();
    } else if (moveInfo.flags && (moveInfo.flags.includes("k") || moveInfo.flags.includes("q"))) {
      sfx.playCastle();
    } else {
      sfx.playMove();
    }
  }

  selectedSquare = null;
  legalMovesForSelected = [];
  renderBoard();
  updatePanels();

  // If playing vs AI and it's Black's turn, let AI calculate move
  if (
    roomState.status === "playing" &&
    vsAiMode &&
    chess.turn() === "b" &&
    !chess.game_over()
  ) {
    setTimeout(makeAiMove, 520);
  }
}

// ---------------------------------------------------------------------------
// 4. Smart Minimax Chess AI (For vs AI Mode)
// ---------------------------------------------------------------------------
function evaluateBoard(board) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const val = PIECE_VALUES[piece.type] || 0;
      const centerBonus = (r >= 2 && r <= 5 && c >= 2 && c <= 5) ? 15 : 0;
      score += piece.color === "b" ? (val + centerBonus) : -(val + centerBonus);
    }
  }
  return score;
}

function pickBestAiMove() {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;

  let bestMove = moves[0];
  let bestScore = -999999;

  for (const m of moves) {
    chess.move(m);
    if (chess.in_checkmate()) {
      chess.undo();
      return m;
    }

    // 1-ply lookahead response
    const oppMoves = chess.moves({ verbose: true });
    let worstReplyScore = 999999;
    if (oppMoves.length === 0) {
      worstReplyScore = 0;
    } else {
      for (const om of oppMoves) {
        chess.move(om);
        const evalScore = evaluateBoard(chess.board());
        if (evalScore < worstReplyScore) worstReplyScore = evalScore;
        chess.undo();
      }
    }
    chess.undo();

    const jitter = Math.random() * 12;
    if (worstReplyScore + jitter > bestScore) {
      bestScore = worstReplyScore + jitter;
      bestMove = m;
    }
  }
  return bestMove;
}

function makeAiMove() {
  if (chess.game_over() || chess.turn() !== "b") return;
  const move = pickBestAiMove();
  if (!move) return;
  executeMove(move.from, move.to, "q");
}

// ---------------------------------------------------------------------------
// 5. Move Execution & Game Over Check
// ---------------------------------------------------------------------------
function executeMove(fromSq, toSq, promotion = "q") {
  const moveObj = chess.move({ from: fromSq, to: toSq, promotion });
  if (!moveObj) return false;

  lastMove = { from: fromSq, to: toSq };
  selectedSquare = null;
  legalMovesForSelected = [];

  if (chess.in_checkmate()) {
    sfx.playWin();
  } else if (chess.in_check()) {
    sfx.playCheck();
  } else if (moveObj.captured) {
    sfx.playCapture();
  } else if (moveObj.flags.includes("k") || moveObj.flags.includes("q")) {
    sfx.playCastle();
  } else {
    sfx.playMove();
  }

  let overPayload = null;
  if (chess.game_over()) {
    gameEnded = true;
    roomState.status = "finished";
    if (chess.in_checkmate()) {
      const winColor = moveObj.color; // 'w' or 'b'
      const winPlayer = winColor === "w" ? roomState.white : roomState.black;
      const losePlayer = winColor === "w" ? roomState.black : roomState.white;
      roomState.winner = winPlayer ? winPlayer.name : (winColor === "w" ? "White" : "Black");
      roomState.reason = "Checkmate";
      overPayload = {
        winner_id: winPlayer ? winPlayer.user_id : 0,
        winner_name: roomState.winner,
        loser_id: losePlayer ? losePlayer.user_id : 0,
        loser_name: losePlayer ? losePlayer.name : "Opponent",
        reason: "Checkmate",
      };
    } else {
      roomState.winner = "Draw";
      roomState.reason = chess.in_stalemate() ? "Stalemate" : "Draw";
      overPayload = {
        winner_id: 0,
        winner_name: "Draw",
        loser_id: 0,
        loser_name: "",
        reason: roomState.reason,
      };
    }
  }

  wsSend({
    action: "move",
    fen: chess.fen(),
    move: {
      from: moveObj.from,
      to: moveObj.to,
      captured: moveObj.captured || null,
      flags: moveObj.flags || "",
    },
    game_over: overPayload,
  });

  renderBoard();
  updatePanels();

  if (
    !chess.game_over() &&
    vsAiMode &&
    chess.turn() === "b" &&
    !isOnline
  ) {
    setTimeout(makeAiMove, 520);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 6. Board Rendering & UI Panels
// ---------------------------------------------------------------------------
function renderBoard() {
  const boardEl = document.getElementById("chessBoard");
  boardEl.innerHTML = "";

  const boardData = chess.board();
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const inCheck = chess.in_check();
  const turnColor = chess.turn();

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      const r = isFlipped ? 7 - displayRow : displayRow;
      const c = isFlipped ? 7 - displayCol : displayCol;
      const sqName = `${files[c]}${8 - r}`;
      const isLight = (r + c) % 2 === 0;

      const sqDiv = document.createElement("div");
      sqDiv.className = `square ${isLight ? "light" : "dark"}`;
      sqDiv.dataset.sq = sqName;

      if (selectedSquare === sqName) {
        sqDiv.classList.add("selected");
      }
      if (lastMove && (lastMove.from === sqName || lastMove.to === sqName)) {
        sqDiv.classList.add("last-move");
      }

      const piece = boardData[r][c];
      if (piece && piece.type === "k" && piece.color === turnColor && inCheck) {
        sqDiv.classList.add("in-check");
      }

      // Coordinate labels on edges
      if (displayCol === 0) {
        const rankSpan = document.createElement("span");
        rankSpan.className = "coord-label coord-rank";
        rankSpan.textContent = String(8 - r);
        sqDiv.appendChild(rankSpan);
      }
      if (displayRow === 7) {
        const fileSpan = document.createElement("span");
        fileSpan.className = "coord-label coord-file";
        fileSpan.textContent = files[c];
        sqDiv.appendChild(fileSpan);
      }

      if (piece) {
        const pSpan = document.createElement("span");
        pSpan.className = `piece ${piece.color === "w" ? "white-piece" : "black-piece"}`;
        pSpan.textContent = PIECE_GLYPHS[`${piece.color}${piece.type}`];
        sqDiv.appendChild(pSpan);
      }

      const legalMove = legalMovesForSelected.find((m) => m.to === sqName);
      if (legalMove) {
        const indicator = document.createElement("div");
        indicator.className = piece ? "capture-ring" : "move-dot";
        sqDiv.appendChild(indicator);
      }

      sqDiv.addEventListener("pointerdown", () => onSquareTap(sqName));
      boardEl.appendChild(sqDiv);
    }
  }
}

function onSquareTap(sqName) {
  if (roomState.status !== "playing" || chess.game_over()) return;

  const currentTurn = chess.turn();
  const canControlTurn =
    (vsAiMode && currentTurn === "w") ||
    (!vsAiMode && currentTurn === myColor);

  if (!canControlTurn) return;

  // If tapping a valid destination for currently selected piece
  const targetMove = legalMovesForSelected.find((m) => m.to === sqName);
  if (selectedSquare && targetMove) {
    executeMove(selectedSquare, sqName, "q");
    return;
  }

  // Otherwise check if tapping own piece
  const piece = chess.get(sqName);
  if (piece && piece.color === currentTurn) {
    selectedSquare = sqName;
    legalMovesForSelected = chess.moves({ square: sqName, verbose: true });
    sfx.playSelect();
    renderBoard();
  } else {
    selectedSquare = null;
    legalMovesForSelected = [];
    renderBoard();
  }
}

function updatePanels() {
  const banner = document.getElementById("statusBanner");
  const turn = chess.turn(); // 'w' or 'b'

  const whitePlayer = roomState.white || { name: "Waiting..." };
  const blackPlayer = roomState.black || { name: "Waiting..." };

  const bottomIsWhite = !isFlipped;
  const bottomPlayer = bottomIsWhite ? whitePlayer : blackPlayer;
  const topPlayer = bottomIsWhite ? blackPlayer : whitePlayer;
  const bottomColor = bottomIsWhite ? "w" : "b";
  const topColor = bottomIsWhite ? "b" : "w";

  document.getElementById("bottomPieceBadge").textContent = bottomColor === "w" ? "⚪" : "⚫";
  document.getElementById("topPieceBadge").textContent = topColor === "w" ? "⚪" : "⚫";

  document.getElementById("bottomPlayerName").textContent =
    `${bottomPlayer.name} (${bottomColor === "w" ? "White" : "Black"})`;
  document.getElementById("topPlayerName").textContent =
    topPlayer.name !== "Waiting..."
      ? `${topPlayer.name} (${topColor === "w" ? "White" : "Black"})`
      : `Waiting for ${topColor === "w" ? "White" : "Black"}...`;

  const bottomCard = document.getElementById("bottomPlayerCard");
  const topCard = document.getElementById("topPlayerCard");
  const bottomPill = document.getElementById("bottomTurnPill");
  const topPill = document.getElementById("topTurnPill");

  if (roomState.status === "playing" && !chess.game_over()) {
    if (turn === bottomColor) {
      bottomCard.classList.add("active-turn");
      topCard.classList.remove("active-turn");
      bottomPill.textContent = chess.in_check() ? "⚠️ IN CHECK!" : "YOUR MOVE";
      topPill.textContent = "WAITING";
    } else {
      topCard.classList.add("active-turn");
      bottomCard.classList.remove("active-turn");
      topPill.textContent = chess.in_check() ? "⚠️ IN CHECK!" : "THINKING...";
      bottomPill.textContent = "WAITING";
    }

    const activeName = turn === "w" ? whitePlayer.name : blackPlayer.name;
    banner.textContent = chess.in_check()
      ? `🚨 CHECK! ${activeName} must protect the King!`
      : `♟️ ${activeName}'s Turn (${turn === "w" ? "White ⚪" : "Black ⚫"})`;
  } else if (roomState.status === "waiting") {
    bottomCard.classList.remove("active-turn");
    topCard.classList.remove("active-turn");
    banner.textContent = "⏳ Waiting for opponent... Tap '🤖 vs AI' to start solo!";
  }

  // Show Game Over Modal if finished
  const modal = document.getElementById("gameOverModal");
  if (roomState.status === "finished" || chess.game_over()) {
    const winner = roomState.winner || "Champion";
    const reason = roomState.reason || "Checkmate";
    document.getElementById("modalTitle").textContent =
      winner === "Draw" ? "🤝 DRAW MATCH!" : `👑 ${ reason.toUpperCase() }!`;
    document.getElementById("modalSubtitle").textContent =
      winner === "Draw"
        ? `Match ended in a draw (${reason}).`
        : `🏆 ${winner} won the Chess Royale match!`;
    modal.classList.remove("hidden");
  } else {
    modal.classList.add("hidden");
  }
}

function spawnFloatingEmoji(emoji) {
  const layer = document.getElementById("floatingEmojiLayer");
  const el = document.createElement("div");
  el.className = "float-emoji";
  el.textContent = emoji;
  el.style.left = `${20 + Math.random() * 60}%`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1850);
}

// ---------------------------------------------------------------------------
// 7. Control Buttons
// ---------------------------------------------------------------------------
document.getElementById("vsBotBtn").addEventListener("click", () => {
  sfx.playCastle();
  if (!wsSend({ action: "play_ai" })) {
    vsAiMode = true;
    myColor = "w";
    isFlipped = false;
    chess.reset();
    roomState.status = "playing";
    roomState.white = { user_id: MY_USER_ID, name: MY_NAME };
    roomState.black = { user_id: 900099, name: "Miku Chess AI 🤖", is_ai: true };
    renderBoard();
    updatePanels();
  }
});

document.getElementById("resignBtn").addEventListener("click", () => {
  if (roomState.status !== "playing") return;
  sfx.playCapture();
  if (!wsSend({ action: "resign" })) {
    roomState.status = "finished";
    roomState.winner = roomState.black ? roomState.black.name : "Opponent";
    roomState.reason = "Resignation";
    updatePanels();
  }
});

document.getElementById("flipBoardBtn").addEventListener("click", () => {
  isFlipped = !isFlipped;
  sfx.playSelect();
  renderBoard();
  updatePanels();
});

document.getElementById("soundToggleBtn").addEventListener("click", (e) => {
  sfx.enabled = !sfx.enabled;
  e.currentTarget.textContent = sfx.enabled ? "🔊" : "🔇";
});

document.getElementById("rematchBtn").addEventListener("click", () => {
  sfx.playCastle();
  if (!wsSend({ action: "reset" })) {
    chess.reset();
    lastMove = null;
    gameEnded = false;
    roomState.status = "playing";
    roomState.winner = null;
    renderBoard();
    updatePanels();
  }
});

document.getElementById("shareBtn").addEventListener("click", () => {
  if (tg && tg.sendData) {
    tg.sendData(
      JSON.stringify({
        game: "chess",
        room: ROOM_ID,
        winner: roomState.winner || MY_NAME,
        reason: roomState.reason || "Checkmate",
      })
    );
  }
});

document.querySelectorAll(".emoji-btn[data-emoji]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.getAttribute("data-emoji");
    if (!wsSend({ action: "emoji", emoji })) {
      spawnFloatingEmoji(emoji);
    }
  });
});

connectWebSocket();
renderBoard();
updatePanels();
