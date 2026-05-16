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

// ---------- Uploads setup ----------
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

// ---------- Supabase ----------
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

// ---------- Audit Logger ----------
async function logAuditEvent({ eventType, roomId = null, userId = 'system', ipAddress = null, details = {} }) {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      event_type: eventType,
      room_id: roomId,
      user_id: userId,
      ip_address: ipAddress,
      details
    });
    if (error) throw error;
  } catch (err) {
    console.error(`[AUDIT FAIL] ${eventType} (user ${userId}):`, err.message);
  }
}

const Audit = {
  depositInitiated(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_INITIATED', userId, ipAddress: ip, details: data }); },
  depositCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_COMPLETED', userId, ipAddress: ip, details: data }); },
  depositFailed(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_FAILED', userId, ipAddress: ip, details: data }); },
  withdrawalRequested(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REQUESTED', userId, ipAddress: ip, details: data }); },
  withdrawalCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_COMPLETED', userId, ipAddress: ip, details: data }); },
  withdrawalRejected(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REJECTED', userId, ipAddress: ip, details: data }); },
  bingoCalled(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_CALLED', roomId, userId, ipAddress: ip, details: data }); },
  bingoRejected(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_REJECTED', roomId, userId, ipAddress: ip, details: data }); },
  winPaidOut(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'WIN_PAID_OUT', roomId, userId, ipAddress: ip, details: data }); },
  numberDrawn(roomId, data) { return logAuditEvent({ eventType: 'NUMBER_DRAWN', roomId, details: data }); },
  cardAssigned(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'CARD_ASSIGNED', roomId, userId, ipAddress: ip, details: data }); },
  adminAction(eventType, adminId, ip, details) { return logAuditEvent({ eventType, userId: adminId, ipAddress: ip, details }); },
  suspicious(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'SUSPICIOUS_BEHAVIOR_DETECTED', roomId, userId, ipAddress: ip, details: data }); }
};

// ---------- Suspicious Activity Detector ----------
const winTimestamps = new Map();
const WINDOW_MS = 120_000;
const MAX_WINS_IN_WINDOW = 3;

function detectRapidWins(roomId, userId, ip) {
  const key = `${roomId}:${userId}`;
  if (!winTimestamps.has(key)) winTimestamps.set(key, []);
  const times = winTimestamps.get(key);
  const now = Date.now();
  times.push(now);
  const recent = times.filter(t => now - t <= WINDOW_MS);
  winTimestamps.set(key, recent);
  if (recent.length > MAX_WINS_IN_WINDOW) {
    Audit.suspicious(roomId, userId, ip, {
      detectionSource: 'win_velocity_check',
      reason: `More than ${MAX_WINS_IN_WINDOW} wins in ${WINDOW_MS/1000}s`,
      evidence: { recentWinCount: recent.length, windowMs: WINDOW_MS }
    });
    return true;
  }
  return false;
}

// ---------- Bingo card generator ----------
function generateCard() {
  const columns = [
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],
    [31,32,33,34,35,36,37,38,39,40,41,42,43,44,45],
    [46,47,48,49,50,51,52,53,54,55,56,57,58,59,60],
    [61,62,63,64,65,66,67,68,69,70,71,72,73,74,75]
  ];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const colNumbers = [];
    const available = [...columns[col]];
    for (let row = 0; row < 5; row++) {
      if (col === 2 && row === 2) { colNumbers.push('FREE'); }
      else { colNumbers.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]); }
    }
    card.push(colNumbers);
  }
  const transposed = [];
  for (let r = 0; r < 5; r++) transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  return transposed;
}

// ---------- Game Room Management ----------
class GameRoom {
  constructor(stake) {
    this.stake = stake;
    this.status = 'lobby';
    this.players = [];
    this.takenCardNumbers = new Set();
    this.calledNumbers = [];
    this.prizePool = 0;
    this.lobbyTimer = null;
    this.callInterval = null;
    this.lobbyEndTime = 0;
    this.cardSet = Array.from({ length: 100 }, () => generateCard());
    this.winners = [];
    this.bingoGraceTimeout = null;
    this.winningNumber = null;
    this.startLobbyTimer();
  }

  startLobbyTimer() {
    this.lobbyEndTime = Date.now() + 30000;
    this.lobbyTimer = setTimeout(() => this.startGame(), 30000);
  }

  async startGame() {
    // Remove players with insufficient balance
    const toRemove = [];
    for (const p of this.players) {
      const user = users[p.telegramId];
      if (!user || user.balance < this.stake) toRemove.push(p);
    }
    for (const p of toRemove) {
      const idx = this.players.findIndex(pl => pl.telegramId === p.telegramId);
      if (idx !== -1) this.players.splice(idx, 1);
      if (p.cardNumber) this.takenCardNumbers.delete(p.cardNumber);
    }
    this.broadcast('cardTaken', { takenNumbers: Array.from(this.takenCardNumbers) });
    this.broadcast('playersCount', this.players.length);

    if (this.players.length === 0) {
      this.status = 'ended';
      setTimeout(() => resetRoom(this.stake), 3000);
      return;
    }

    // Deduct entry fee
    for (const p of this.players) {
      const user = users[p.telegramId];
      if (user) {
        user.balance -= this.stake;
        await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
        const socket = await getSocketByUserId(p.telegramId);
        if (socket) socket.emit('balanceUpdate', user.balance);
        Audit.adminAction('ENTRY_FEE_PAID', 'system', null, { userId: p.telegramId, amount: this.stake, currency: 'ETB', room: `stake_${this.stake}` });
      }
    }

    this.prizePool = 0.8 * (this.stake * this.players.length);
    this.status = 'running';
    this.calledNumbers = [];
    this.winningNumber = null;
    this.broadcast('gameStarted', { prizePool: this.prizePool, playersCount: this.players.length });
    this.startCalling();
  }

  startCalling() {
    this.callInterval = setInterval(() => {
      if (this.status !== 'running') { clearInterval(this.callInterval); return; }
      const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
      const available = allNums.filter(n => !this.calledNumbers.includes(n));
      if (available.length === 0) {
        clearInterval(this.callInterval);
        this.endGameWithWinners();
        return;
      }
      const number = available[Math.floor(Math.random() * available.length)];
      this.calledNumbers.push(number);
      this.broadcast('numberCalled', { number, calledNumbers: this.calledNumbers });
      Audit.numberDrawn(`stake_${this.stake}`, { drawnNumber: number, drawIndex: this.calledNumbers.length });
    }, 4000);
  }

  async endGameWithWinners() {
    this.status = 'ended';
    clearInterval(this.callInterval);

    if (this.winners.length > 0) {
      const prizeEach = Math.floor(this.prizePool / this.winners.length);
      for (const w of this.winners) {
        const user = users[w.telegramId];
        if (user) {
          user.balance += prizeEach;
          await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', w.telegramId);
          const winnerSocket = await getSocketByUserId(w.telegramId);
          if (winnerSocket) winnerSocket.emit('balanceUpdate', user.balance);
          Audit.winPaidOut(`stake_${this.stake}`, w.telegramId, null, {
            amount: prizeEach,
            currency: 'ETB',
            totalPrizePool: this.prizePool,
            totalWinners: this.winners.length
          });
          detectRapidWins(`stake_${this.stake}`, w.telegramId, null);
        }
      }

      const totalEntryFees = this.players.length * this.stake;
      const houseProfit = totalEntryFees - this.prizePool;
      await supabase.from('game_rounds').insert({
        stake: this.stake,
        total_entry_fees: totalEntryFees,
        prize_pool: this.prizePool,
        house_profit: houseProfit
      });

      const winnerNames = this.winners.map(w => w.username);
      this.broadcast('gameEnded', {
        winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
        winners: winnerNames,
        prizeEach,
        totalPrize: this.prizePool,
        winnerCount: this.winners.length,
        winningNumber: this.winningNumber
      });
    } else {
      this.broadcast('gameEnded', { noWinner: true });
    }

    this.winners = [];
    clearTimeout(this.bingoGraceTimeout);
    this.bingoGraceTimeout = null;
    setTimeout(() => resetRoom(this.stake), 5000);
  }

  broadcast(event, data) {
    io.to(`stake_${this.stake}`).emit(event, data);
  }

  // Helper to get player by socket id
  getPlayer(socketId) {
    return this.players.find(p => p.socketId === socketId);
  }
}

// Store rooms
const gameRooms = {
  10: null,
  20: null
};

function getOrCreateRoom(stake) {
  if (!gameRooms[stake] || gameRooms[stake].status === 'ended') {
    gameRooms[stake] = new GameRoom(stake);
  }
  return gameRooms[stake];
}

function resetRoom(stake) {
  gameRooms[stake] = new GameRoom(stake);
}

// ---------- User cache ----------
const users = {};
async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];
  const { data } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 10 };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 10 };
  }
  return users[id];
}

async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

// ---------- Telegram verification & endpoints ----------
function verifyTelegram(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return calculatedHash === hash;
}

app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) return res.status(403).json({ success: false });
  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);
  const user = await loadUser(id, userData.first_name || userData.username);
  req.session.userId = id;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ success: false, error: 'Session save failed' });
    }
    res.json({ success: true, userId: id, username: user.username, balance: user.balance });
  });
});

app.get('/api/deposit-accounts', (req, res) => {
  res.json({
    telebirr: process.env.ADMIN_PHONE || '0924839730',
    cbebirr: process.env.CBE_ACCOUNT || '1000123456789',
    mpesa: process.env.MPESA_ACCOUNT || '251912345678'
  });
});

// Deposit/Withdraw endpoints (unchanged, but with room awareness)
app.post('/api/request-deposit', upload.single('proof'), async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { phone, amount, payment_type } = req.body;
  const file = req.file;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!file) return res.status(400).json({ error: 'Proof image required' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const proofPath = `/uploads/${file.filename}`;
  const { data, error } = await supabase.from('deposit_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone: phone || null, payment_type, proof_path: proofPath
  }).select().single();
  if (error) { console.error('Deposit insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.depositInitiated(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: payment_type });
  res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB via ${payment_type} submitted.` });
});

app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { amount, phone, withdrawal_type, name } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(withdrawal_type)) return res.status(400).json({ error: 'Invalid withdrawal type' });
  const receiver = (phone || '').trim();
  if (!receiver || receiver.length < 10) return res.status(400).json({ error: 'Valid receiver phone/account required' });
  const receiverName = (name || '').trim();
  if (!receiverName) return res.status(400).json({ error: 'Account holder name is required' });
  const user = await loadUser(userId, null);
  if (!user || user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  const { data, error } = await supabase.from('withdrawal_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone_number: receiver, withdrawal_type, receiver_name: receiverName
  }).select().single();
  if (error) { console.error('Withdraw insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.withdrawalRequested(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: withdrawal_type, receiver, name: receiverName });
  res.json({ success: true, requestId: data.id, message: `Withdrawal request of ${amt} ETB via ${withdrawal_type} to ${receiver} submitted.` });
});

// Admin endpoints (unchanged, omitted for brevity – keep your existing ones)
// ... (admin deposit/withdrawal endpoints remain as in your original server)

// ---------- Socket.IO with rooms ----------
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  let currentRoom = null;
  let currentStake = null;

  socket.on('joinRoom', async ({ stake }) => {
    if (stake !== 10 && stake !== 20) return;
    currentStake = stake;
    currentRoom = `stake_${stake}`;
    socket.join(currentRoom);
    const room = getOrCreateRoom(stake);
    const userBalance = users[socket.userId]?.balance || 0;
    socket.emit('balanceUpdate', userBalance);
    
    if (room.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((room.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', { startsIn: timeLeft, takenNumbers: Array.from(room.takenCardNumbers), playersCount: room.players.length });
    } else if (room.status === 'running') {
      socket.emit('gameStarted', { prizePool: room.prizePool, playersCount: room.players.length });
      const player = room.players.find(p => p.telegramId === socket.userId);
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('markedNumbers', player.markedNumbers);
        socket.emit('calledNumbers', room.calledNumbers);
      }
    }
  });

  socket.on('selectCardNumber', async (data) => {
    if (!currentStake) return;
    const room = getOrCreateRoom(currentStake);
    if (room.status !== 'lobby') return;

    let cardNumber, requestedStake;
    if (typeof data === 'object') {
      cardNumber = data.cardNumber;
      requestedStake = data.stake;
    } else {
      cardNumber = data;
      requestedStake = currentStake;
    }
    if (requestedStake !== currentStake) return;

    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentStake) {
      socket.emit('cardSelectionFailed', `Insufficient balance. Need ${currentStake} ETB.`);
      return;
    }

    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (room.takenCardNumbers.has(num)) {
      socket.emit('cardSelectionFailed', 'Card number already taken.');
      return;
    }

    // Remove existing player entry
    const existing = room.players.find(p => p.telegramId === socket.userId);
    if (existing) {
      room.takenCardNumbers.delete(existing.cardNumber);
      room.players = room.players.filter(p => p.telegramId !== socket.userId);
    }

    room.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      socketId: socket.id,
      telegramId: socket.userId,
      username: socket.username,
      card: room.cardSet[num - 1],
      markedNumbers: [],
      cardNumber: num,
      ip: ip
    };
    room.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: num.toString(), stake: currentStake });
    io.to(currentRoom).emit('cardTaken', { number: num, takenNumbers: Array.from(room.takenCardNumbers) });
    io.to(currentRoom).emit('playersCount', room.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('newCardNumber', async () => {
    if (!currentStake) return;
    const room = getOrCreateRoom(currentStake);
    if (room.status !== 'lobby') return;

    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < currentStake) {
      socket.emit('cardSelectionFailed', `Insufficient balance. Need ${currentStake} ETB.`);
      return;
    }

    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) if (!room.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) {
      socket.emit('cardSelectionFailed', 'All numbers are taken.');
      return;
    }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];

    const existing = room.players.find(p => p.telegramId === socket.userId);
    if (existing) {
      room.takenCardNumbers.delete(existing.cardNumber);
      room.players = room.players.filter(p => p.telegramId !== socket.userId);
    }

    room.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      socketId: socket.id,
      telegramId: socket.userId,
      username: socket.username,
      card: room.cardSet[randomNum - 1],
      markedNumbers: [],
      cardNumber: randomNum,
      ip: ip
    };
    room.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: randomNum.toString(), stake: currentStake });
    io.to(currentRoom).emit('cardTaken', { number: randomNum, takenNumbers: Array.from(room.takenCardNumbers) });
    io.to(currentRoom).emit('playersCount', room.players.length);
    socket.emit('yourCard', player.card);
  });

  socket.on('markNumber', (number) => {
    if (!currentStake) return;
    const room = getOrCreateRoom(currentStake);
    if (room.status !== 'running') return;
    const player = room.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const num = Number(number);
    if (number !== 'FREE' && (!Number.isInteger(num) || num < 1 || num > 75)) return;
    const flat = player.card.flat();
    if (!flat.includes(number)) return;
    if (!room.calledNumbers.includes(num) && number !== 'FREE') return;
    if (player.markedNumbers.includes(number)) return;
    player.markedNumbers.push(number);
    socket.emit('markedNumbers', player.markedNumbers);
  });

  socket.on('claimBingo', () => {
    if (!currentStake) return;
    const room = getOrCreateRoom(currentStake);
    if (room.status !== 'running') return;
    const player = room.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const lastCalled = room.calledNumbers.length > 0 ? room.calledNumbers[room.calledNumbers.length - 1] : null;
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (lastCalled === null || !isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      socket.emit('invalidBingo');
      Audit.bingoRejected(`stake_${currentStake}`, socket.userId, ip, { reason: 'invalid_bingo_call', lastCalled });
      return;
    }
    if (room.winners.find(w => w.telegramId === socket.userId)) return;
    if (room.winningNumber === null) room.winningNumber = lastCalled;
    room.winners.push({ telegramId: socket.userId, username: socket.username });
    Audit.bingoCalled(`stake_${currentStake}`, socket.userId, ip, { cardId: player.cardNumber.toString(), calledNumber: lastCalled });
    socket.emit('bingoValid');
    if (!room.bingoGraceTimeout && room.winners.length === 1) {
      io.to(currentRoom).emit('multipleBingoPossible', { message: 'Bingo claimed! Waiting for other winners...' });
      room.bingoGraceTimeout = setTimeout(() => room.endGameWithWinners(), 3000);
    }
  });

  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });

  socket.on('disconnect', () => {
    if (currentStake && gameRooms[currentStake]) {
      const room = gameRooms[currentStake];
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const removed = room.players[idx];
        room.takenCardNumbers.delete(removed.cardNumber);
        room.players.splice(idx, 1);
        io.to(currentRoom).emit('cardTaken', { takenNumbers: Array.from(room.takenCardNumbers) });
        io.to(currentRoom).emit('playersCount', room.players.length);
      }
    }
  });
});

// Bingo helper functions
function getLines(card) {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([card[r][0], card[r][1], card[r][2], card[r][3], card[r][4]]);
  for (let c = 0; c < 5; c++) lines.push([card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]]);
  lines.push([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
  lines.push([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);
  lines.push([card[0][0], card[0][4], card[4][0], card[4][4]]);
  return lines;
}
function isLineComplete(line, marked) {
  return line.every(val => val === 'FREE' || marked.includes(val));
}
function isBingoValidOnLastCall(card, marked, lastCalled) {
  if (lastCalled === null) return false;
  const lines = getLines(card);
  for (const line of lines) {
    if (!isLineComplete(line, marked)) continue;
    if (!line.includes(lastCalled)) continue;
    return true;
  }
  return false;
}

// Admin endpoints (keep your existing ones)
// ... (include all admin endpoints from your original server)

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));
