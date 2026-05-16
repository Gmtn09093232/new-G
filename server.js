require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Uploads setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Supabase
console.log('Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
  if (error) console.error('❌ Supabase error:', error.message);
  else console.log('✅ Supabase connected');
})();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use('/uploads', express.static(uploadDir));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none'
  }
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// Audit Logger (same as before)
async function logAuditEvent({ eventType, roomId = null, userId = 'system', ipAddress = null, details = {} }) {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      event_type: eventType, room_id: roomId, user_id: userId, ip_address: ipAddress, details
    });
    if (error) throw error;
  } catch (err) { console.error(`[AUDIT FAIL] ${eventType} (user ${userId}):`, err.message); }
}
const Audit = { /* same as original, omitted for brevity but include all functions */ };

// Suspicious detector (unchanged)
const winTimestamps = new Map();
const WINDOW_MS = 120_000;
const MAX_WINS_IN_WINDOW = 3;
function detectRapidWins(roomId, userId, ip) { /* same as original */ }

// Endpoints (deposit, withdraw, admin, etc.) unchanged
app.get('/api/deposit-accounts', (req, res) => { /* ... */ });
app.post('/api/telegram-miniapp-auth', async (req, res) => { /* ... */ });
app.post('/admin/add-balance', async (req, res) => { /* ... */ });
// ... all other endpoints remain identical to original ...

// ---------- Multi-Game Bingo Engine ----------
// Each game has its own state, identified by stake (10 or 20)
const games = new Map(); // key: stake (10 or 20), value: game object

function createGame(stake) {
  return {
    status: 'lobby',                // lobby, running, ended
    players: [],                    // player objects
    takenCardNumbers: new Set(),    // 1-100
    calledNumbers: [],
    entryFee: stake,
    prizePool: 0,
    lobbyTimer: null,
    callInterval: null,
    lobbyEndTime: 0,
    cardSet: Array.from({ length: 100 }, () => generateCard()),
    winners: [],
    bingoGraceTimeout: null,
    winningNumber: null,
    stake: stake
  };
}

function generateCard() { /* same as original */ }

function resetGame(game) {
  clearInterval(game.callInterval);
  clearTimeout(game.lobbyTimer);
  clearTimeout(game.bingoGraceTimeout);
  game.status = 'lobby';
  game.players = [];
  game.takenCardNumbers.clear();
  game.calledNumbers = [];
  game.prizePool = 0;
  game.winners = [];
  game.bingoGraceTimeout = null;
  game.winningNumber = null;
  game.lobbyEndTime = Date.now() + 30000;
  game.cardSet = Array.from({ length: 100 }, () => generateCard());
  // emit lobbyState to all clients in this game's room
  io.to(`game_${game.stake}`).emit('lobbyState', { startsIn: 30, takenNumbers: [], playersCount: 0, stake: game.stake });
  game.lobbyTimer = setTimeout(() => startGame(game), 30000);
}

async function startGame(game) {
  // remove players with insufficient balance
  const toRemove = [];
  for (const p of game.players) {
    const user = users[p.telegramId];
    if (!user || user.balance < game.entryFee) toRemove.push(p);
  }
  for (const p of toRemove) {
    const idx = game.players.findIndex(pl => pl.telegramId === p.telegramId);
    if (idx !== -1) game.players.splice(idx, 1);
    if (p.cardNumber) game.takenCardNumbers.delete(p.cardNumber);
  }
  io.to(`game_${game.stake}`).emit('cardTaken', { takenNumbers: Array.from(game.takenCardNumbers), stake: game.stake });
  io.to(`game_${game.stake}`).emit('playersCount', game.players.length);

  if (game.players.length === 0) {
    game.status = 'ended';
    setTimeout(() => resetGame(game), 3000);
    return;
  }

  // deduct entry fee
  for (const p of game.players) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= game.entryFee;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      const playerSocket = await getSocketByUserId(p.telegramId);
      if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
      Audit.adminAction('ENTRY_FEE_PAID', 'system', null, { userId: p.telegramId, amount: game.entryFee, currency: 'ETB' });
    }
  }

  game.prizePool = 0.8 * (game.entryFee * game.players.length);
  game.status = 'running';
  game.calledNumbers = [];
  game.winningNumber = null;
  io.to(`game_${game.stake}`).emit('gameStarted', { prizePool: game.prizePool, playersCount: game.players.length, stake: game.stake });
  startCalling(game);
}

async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

function startCalling(game) {
  game.callInterval = setInterval(() => {
    if (game.status !== 'running') { clearInterval(game.callInterval); return; }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !game.calledNumbers.includes(n));
    if (available.length === 0) {
      clearInterval(game.callInterval);
      endGameWithWinners(game);
      return;
    }
    const number = available[Math.floor(Math.random() * available.length)];
    game.calledNumbers.push(number);
    io.to(`game_${game.stake}`).emit('numberCalled', { number, calledNumbers: game.calledNumbers, stake: game.stake });
    Audit.numberDrawn(`game_${game.stake}`, { drawnNumber: number, drawIndex: game.calledNumbers.length, timestamp: new Date().toISOString() });
  }, 4000);
}

function getLines(card) { /* same */ }
function isLineComplete(line, marked) { /* same */ }
function isBingoValidOnLastCall(card, marked, lastCalled) { /* same */ }

async function endGameWithWinners(game) {
  game.status = 'ended';
  clearInterval(game.callInterval);

  if (game.winners.length > 0) {
    const prizeEach = Math.floor(game.prizePool / game.winners.length);
    for (const w of game.winners) {
      const user = users[w.telegramId];
      if (user) {
        user.balance += prizeEach;
        await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', w.telegramId);
        const winnerSocket = await getSocketByUserId(w.telegramId);
        if (winnerSocket) winnerSocket.emit('balanceUpdate', user.balance);
        Audit.winPaidOut(`game_${game.stake}`, w.telegramId, null, {
          amount: prizeEach, currency: 'ETB', totalPrizePool: game.prizePool, totalWinners: game.winners.length
        });
        detectRapidWins(`game_${game.stake}`, w.telegramId, null);
      }
    }
    const totalEntryFees = game.players.length * game.entryFee;
    const houseProfit = totalEntryFees - game.prizePool;
    await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees, prize_pool: game.prizePool, house_profit: houseProfit
    });
    const winnerNames = game.winners.map(w => w.username);
    io.to(`game_${game.stake}`).emit('gameEnded', {
      winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
      winners: winnerNames,
      prizeEach,
      totalPrize: game.prizePool,
      winnerCount: game.winners.length,
      winningNumber: game.winningNumber,
      stake: game.stake
    });
  } else {
    io.to(`game_${game.stake}`).emit('gameEnded', { noWinner: true, stake: game.stake });
  }
  game.winners = [];
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;
  setTimeout(() => resetGame(game), 5000);
}

// Initialize both games
games.set(10, createGame(10));
games.set(20, createGame(20));
// Start lobby timers
for (let game of games.values()) {
  resetGame(game);
}

// ---------- Socket.IO with multi-game support ----------
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  // Client must first select a stake to join a game room
  socket.on('selectStake', (stake) => {
    if (stake !== 10 && stake !== 20) return;
    // Leave previous stake room if any
    if (socket.currentStake) {
      socket.leave(`game_${socket.currentStake}`);
    }
    socket.currentStake = stake;
    socket.join(`game_${stake}`);
    const game = games.get(stake);
    if (game.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((game.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', { startsIn: timeLeft, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length, stake: game.stake });
    } else if (game.status === 'running') {
      socket.emit('gameStarted', { prizePool: game.prizePool, playersCount: game.players.length, stake: game.stake });
      const player = game.players.find(p => p.telegramId === socket.userId);
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('markedNumbers', player.markedNumbers);
        socket.emit('calledNumbers', game.calledNumbers);
      }
    }
    socket.emit('balanceUpdate', users[socket.userId]?.balance || 0);
  });

  socket.on('selectCardNumber', (data) => {
    if (!socket.currentStake) {
      socket.emit('cardSelectionFailed', 'Please select a stake first (10 or 20 ETB).');
      return;
    }
    const game = games.get(socket.currentStake);
    if (!game || game.status !== 'lobby') return;

    let cardNumber = data.cardNumber || data;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${game.entryFee} birr.`);
      return;
    }
    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (game.takenCardNumbers.has(num)) {
      socket.emit('cardSelectionFailed', 'This number is already taken.');
      return;
    }
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) {
      game.takenCardNumbers.delete(existing.cardNumber);
      game.players = game.players.filter(p => p.telegramId !== socket.userId);
    }
    game.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      telegramId: socket.userId, username: socket.username,
      card: game.cardSet[num - 1], markedNumbers: [], cardNumber: num, ip: ip
    };
    game.players.push(player);
    Audit.cardAssigned(`game_${game.stake}`, socket.userId, ip, { cardId: num.toString(), grid: player.card });
    io.to(`game_${game.stake}`).emit('cardTaken', { number: num, takenNumbers: Array.from(game.takenCardNumbers), stake: game.stake });
    io.to(`game_${game.stake}`).emit('playersCount', game.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('newCardNumber', () => {
    if (!socket.currentStake) {
      socket.emit('cardSelectionFailed', 'Please select a stake first.');
      return;
    }
    const game = games.get(socket.currentStake);
    if (!game || game.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${game.entryFee} birr.`);
      return;
    }
    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) if (!game.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) {
      socket.emit('cardSelectionFailed', 'All numbers are taken.');
      return;
    }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) {
      game.takenCardNumbers.delete(existing.cardNumber);
      game.players = game.players.filter(p => p.telegramId !== socket.userId);
    }
    game.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      telegramId: socket.userId, username: socket.username,
      card: game.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum, ip: ip
    };
    game.players.push(player);
    Audit.cardAssigned(`game_${game.stake}`, socket.userId, ip, { cardId: randomNum.toString(), grid: player.card });
    io.to(`game_${game.stake}`).emit('cardTaken', { number: randomNum, takenNumbers: Array.from(game.takenCardNumbers), stake: game.stake });
    io.to(`game_${game.stake}`).emit('playersCount', game.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('markNumber', (number) => {
    if (!socket.currentStake) return;
    const game = games.get(socket.currentStake);
    if (!game || game.status !== 'running') return;
    const player = game.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const num = Number(number);
    if (number !== 'FREE' && (!Number.isInteger(num) || num < 1 || num > 75)) return;
    const flat = player.card.flat();
    if (!flat.includes(number)) return;
    if (!game.calledNumbers.includes(num) && number !== 'FREE') return;
    if (player.markedNumbers.includes(number)) return;
    player.markedNumbers.push(number);
    socket.emit('markedNumbers', player.markedNumbers);
  });

  socket.on('claimBingo', () => {
    if (!socket.currentStake) return;
    const game = games.get(socket.currentStake);
    if (!game || game.status !== 'running') return;
    const player = game.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const lastCalled = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : null;
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (lastCalled === null || !isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      socket.emit('invalidBingo');
      Audit.bingoRejected(`game_${game.stake}`, socket.userId, ip, { reason: 'invalid_bingo_call', lastCalled });
      return;
    }
    if (game.winners.find(w => w.telegramId === socket.userId)) return;
    if (game.winningNumber === null) game.winningNumber = lastCalled;
    game.winners.push({ telegramId: socket.userId, username: socket.username });
    Audit.bingoCalled(`game_${game.stake}`, socket.userId, ip, { cardId: player.cardNumber.toString(), cardGrid: player.card, calledNumber: lastCalled, winType: 'bingo_line' });
    socket.emit('bingoValid');
    if (!game.bingoGraceTimeout && game.winners.length === 1) {
      io.to(`game_${game.stake}`).emit('multipleBingoPossible', { message: 'Bingo claimed! Waiting for other potential winners...' });
      game.bingoGraceTimeout = setTimeout(() => { endGameWithWinners(game); }, 3000);
    }
  });

  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });
});

// User cache and loadUser function (same as original)
const users = {};
async function loadUser(telegramId, username) { /* unchanged */ }

// All other REST endpoints (deposit, withdraw, admin) remain unchanged.
// ... (include the full original endpoint code here)

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Multi-game Bingo server on port ${PORT}`));
