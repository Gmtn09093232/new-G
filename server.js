require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

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
async function logAuditEvent({
  eventType,
  roomId = null,
  userId = 'system',
  ipAddress = null,
  details = {}
}) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({
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
  if (!winTimestamps.has(userId)) winTimestamps.set(userId, []);
  const times = winTimestamps.get(userId);
  const now = Date.now();
  times.push(now);
  const recent = times.filter(t => now - t <= WINDOW_MS);
  winTimestamps.set(userId, recent);
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

// ---------- Static endpoints ----------
app.get('/api/deposit-accounts', (req, res) => {
  res.json({
    telebirr: process.env.ADMIN_PHONE || '0924839730',
    cbebirr: process.env.CBE_ACCOUNT || '1000123456789',
    mpesa: process.env.MPESA_ACCOUNT || '251912345678'
  });
});

app.get('/api/admin-phone', (req, res) => { res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }); });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'live.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/admin/live-players', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Forbidden: invalid or missing admin secret');
  }
  res.sendFile(path.join(__dirname, 'admin-live-players.html'));
});

// ---------- User cache ----------
const users = {};
async function loadUser(telegramId, username, telegramHandle = null) {
  const id = String(telegramId);
  if (users[id]) return users[id];
  const { data } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
  if (data) {
    users[id] = { 
      id, 
      username: data.username, 
      balance: Number(data.balance),
      telegram_handle: data.telegram_handle
    };
  } else {
    const newUser = { 
      telegram_id: id, 
      username: username || 'Player', 
      telegram_handle: telegramHandle || null,
      balance: 10 
    };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 10, telegram_handle: newUser.telegram_handle };
  }
  return users[id];
}

// ---------- Telegram verification ----------
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
  const displayName = userData.first_name || userData.username || 'Player';
  const handle = userData.username || null;
  const user = await loadUser(id, displayName, handle);
  req.session.userId = id;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ success: false, error: 'Session save failed' });
    }
    res.json({ 
      success: true, 
      userId: id, 
      username: user.username, 
      balance: user.balance,
      telegram_handle: user.telegram_handle
    });
  });
});

// ---------- Admin add balance (records manual deposit) ----------
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = await loadUser(strId, 'unknown');
  user.balance += amt;
  await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);
  
  await supabase.from('deposit_requests').insert({
    telegram_id: strId,
    username: user.username,
    amount: amt,
    status: 'approved',
    phone: null,
    payment_type: 'manual',
    proof_path: null,
    processed_at: new Date().toISOString()
  });
  
  Audit.adminAction('ADMIN_ADD_BALANCE', 'admin', req.ip, { targetUserId: strId, amount: amt, newBalance: user.balance });
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
  res.json({ success: true, newBalance: user.balance });
});

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

// ---------- Multi-stake game states (10, 20, 30 ETB) ----------
function createGameState(entryFee) {
  return {
    status: 'lobby',
    players: [],
    takenCardNumbers: new Set(),
    calledNumbers: [],
    entryFee,
    prizePool: 0,
    lobbyTimer: null,
    callInterval: null,
    lobbyEndTime: 0,
    cardSet: Array.from({ length: 100 }, () => generateCard()),
    winners: [],
    bingoGraceTimeout: null,
    winningNumber: null
  };
}

const games = {
  10: createGameState(10),
  20: createGameState(20),
  30: createGameState(30)
};

function getGame(stake) {
  return games[stake];
}

// Helper to get combined players list for admin (all stakes)
function getAllPlayersList() {
  const allPlayers = [];
  for (const stake of [10, 20, 30]) {
    const game = games[stake];
    game.players.forEach(p => {
      const user = users[p.telegramId];
      allPlayers.push({
        telegramId: p.telegramId,
        username: p.username,
        cardNumber: p.cardNumber,
        stake,
        telegram_handle: user ? user.telegram_handle : null
      });
    });
  }
  return allPlayers;
}

function notifyAdminClients() {
  const data = {
    players: getAllPlayersList(),
    gameStatus: {
      10: games[10].status,
      20: games[20].status,
      30: games[30].status
    }
  };
  adminNamespace.emit('admin:playersList', data);
}

// Reset a specific stake's game
function resetGame(stake) {
  const game = getGame(stake);
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
  game.lobbyEndTime = Date.now() + 45000;
  game.cardSet = Array.from({ length: 100 }, () => generateCard());
  
  io.to(`stake_${stake}`).emit('lobbyState', { stake, startsIn: 45, takenNumbers: [], playersCount: 0 });
  
  game.lobbyTimer = setTimeout(() => startGame(stake), 45000);
  notifyAdminClients();
}

async function startGame(stake) {
  const game = getGame(stake);
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
  io.to(`stake_${stake}`).emit('cardTaken', { stake, takenNumbers: Array.from(game.takenCardNumbers) });
  io.to(`stake_${stake}`).emit('playersCount', { stake, count: game.players.length });
  notifyAdminClients();

  if (game.players.length === 0) {
    game.status = 'ended';
    setTimeout(() => resetGame(stake), 3000);
    notifyAdminClients();
    return;
  }

  for (const p of game.players) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= game.entryFee;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      const playerSocket = await getSocketByUserId(p.telegramId);
      if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
      Audit.adminAction('ENTRY_FEE_PAID', 'system', null, { userId: p.telegramId, amount: game.entryFee, currency: 'ETB', stake });
    }
  }

  const totalEntryFees = game.entryFee * game.players.length;
  if (game.players.length === 1) {
    game.prizePool = totalEntryFees;
  } else {
    game.prizePool = 0.8 * totalEntryFees;
  }

  game.status = 'running';
  game.calledNumbers = [];
  game.winningNumber = null;
  io.to(`stake_${stake}`).emit('gameStarted', { stake, prizePool: game.prizePool, playersCount: game.players.length });
  notifyAdminClients();
  startCalling(stake);
}

async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

function startCalling(stake) {
  const game = getGame(stake);
  game.callInterval = setInterval(() => {
    if (game.status !== 'running') { clearInterval(game.callInterval); return; }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !game.calledNumbers.includes(n));
    if (available.length === 0) {
      clearInterval(game.callInterval);
      endGameWithWinners(stake);
      return;
    }
    const number = available[Math.floor(Math.random() * available.length)];
    game.calledNumbers.push(number);
    io.to(`stake_${stake}`).emit('numberCalled', { stake, number, calledNumbers: game.calledNumbers });
    Audit.numberDrawn(`stake_${stake}`, { drawnNumber: number, drawIndex: game.calledNumbers.length, timestamp: new Date().toISOString() });
  }, 4000);
}

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

async function endGameWithWinners(stake) {
  const game = getGame(stake);
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
        Audit.winPaidOut(`stake_${stake}`, w.telegramId, null, {
          amount: prizeEach,
          currency: 'ETB',
          totalPrizePool: game.prizePool,
          totalWinners: game.winners.length,
          stake
        });
        detectRapidWins(`stake_${stake}`, w.telegramId, null);
      }
    }

    const totalEntryFees = game.players.length * game.entryFee;
    const houseProfit = totalEntryFees - game.prizePool;
    await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees,
      prize_pool: game.prizePool,
      house_profit: houseProfit,
      stake
    });

    const ipCounts = {};
    game.winners.forEach(w => {
      const player = game.players.find(p => p.telegramId === w.telegramId);
      const ip = player ? player.ip : null;
      if (ip) ipCounts[ip] = (ipCounts[ip] || 0) + 1;
    });
    Object.entries(ipCounts).forEach(([ip, count]) => {
      if (count >= 3) {
        Audit.suspicious(`stake_${stake}`, 'system', ip, {
          detectionSource: 'multiple_winners_same_ip',
          reason: `${count} winners from IP ${ip}`,
          evidence: { winners: game.winners.map(w => w.telegramId) }
        });
      }
    });

    const winnerNames = game.winners.map(w => w.username);
    io.to(`stake_${stake}`).emit('gameEnded', {
      stake,
      winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
      winners: winnerNames,
      prizeEach,
      totalPrize: game.prizePool,
      winnerCount: game.winners.length,
      winningNumber: game.winningNumber
    });
  } else {
    io.to(`stake_${stake}`).emit('gameEnded', { stake, noWinner: true });
  }

  game.winners = [];
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;
  setTimeout(() => resetGame(stake), 5000);
  notifyAdminClients();
}

// ---------- Deposit endpoints ----------
app.post('/api/request-deposit', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { phone, amount, payment_type } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { data, error } = await supabase.from('deposit_requests').insert({
    telegram_id: userId,
    username: user.username,
    amount: amt,
    status: 'pending',
    phone: phone || null,
    payment_type,
    proof_path: null
  }).select().single();
  
  if (error) {
    console.error('Deposit insert error:', error.message);
    return res.status(500).json({ error: 'Internal error' });
  }
  
  Audit.depositInitiated(userId, req.ip, {
    transactionId: data.id.toString(),
    amount: amt,
    currency: 'ETB',
    method: payment_type
  });
  
  res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB via ${payment_type} submitted.` });
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('deposit_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('deposit_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('deposit_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), providerRef: reqData.id.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.payment_type || 'unknown' });
    const playerSocket = await getSocketByUserId(reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('deposit_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositFailed(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const playerSocket = await getSocketByUserId(reqData.telegram_id);
    if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ---------- Withdrawal endpoints ----------
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

app.get('/admin/withdrawals', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('withdrawal_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('withdrawal_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
    user.balance -= reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.withdrawal_type || 'N/A', receiver: reqData.phone_number });
    const playerSocket = await getSocketByUserId(reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalRejected(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const playerSocket = await getSocketByUserId(reqData.telegram_id);
    if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

// ---------- Statistics endpoints (with date range & withdrawals by method) ----------
app.get('/stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'stats.html'));
});

// ✅ Stats summary with date range (from, to) – INCLUDES WITHDRAWALS BY METHOD
app.get('/admin/stats-summary', async (req, res) => {
  const { secret, from, to } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    let depositQuery = supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    let withdrawalQuery = supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    let roundsQuery = supabase.from('game_rounds').select('house_profit');

    if (from) {
      const fromDate = new Date(from);
      fromDate.setHours(0,0,0,0);
      depositQuery = depositQuery.gte('created_at', fromDate.toISOString());
      withdrawalQuery = withdrawalQuery.gte('created_at', fromDate.toISOString());
      roundsQuery = roundsQuery.gte('created_at', fromDate.toISOString());
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23,59,59,999);
      depositQuery = depositQuery.lte('created_at', toDate.toISOString());
      withdrawalQuery = withdrawalQuery.lte('created_at', toDate.toISOString());
      roundsQuery = roundsQuery.lte('created_at', toDate.toISOString());
    }

    const { data: deposits, error: depErr } = await depositQuery;
    if (depErr) throw depErr;
    const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);

    const { data: withdrawals, error: wdErr } = await withdrawalQuery;
    if (wdErr) throw wdErr;
    const totalWithdrawals = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);

    const { data: rounds, error: rdErr } = await roundsQuery;
    if (rdErr) throw rdErr;
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);

    // Deposits by method
    let methodQuery = supabase.from('deposit_requests').select('amount, payment_type').eq('status', 'approved');
    if (from) methodQuery = methodQuery.gte('created_at', new Date(from).toISOString());
    if (to) methodQuery = methodQuery.lte('created_at', new Date(to).toISOString());
    const { data: depositsByMethodData, error: methodErr } = await methodQuery;
    const depositsByMethod = { telebirr: 0, cbebirr: 0, mpesa: 0, manual: 0 };
    if (!methodErr && depositsByMethodData) {
      depositsByMethodData.forEach(d => {
        const type = d.payment_type;
        if (type === 'telebirr') depositsByMethod.telebirr += Number(d.amount);
        else if (type === 'cbebirr') depositsByMethod.cbebirr += Number(d.amount);
        else if (type === 'mpesa') depositsByMethod.mpesa += Number(d.amount);
        else depositsByMethod.manual += Number(d.amount);
      });
    }

    // Withdrawals by method
    let withdrawalMethodQuery = supabase.from('withdrawal_requests').select('amount, withdrawal_type').eq('status', 'approved');
    if (from) withdrawalMethodQuery = withdrawalMethodQuery.gte('created_at', new Date(from).toISOString());
    if (to) withdrawalMethodQuery = withdrawalMethodQuery.lte('created_at', new Date(to).toISOString());
    const { data: withdrawalsByMethodData, error: wdMethodErr } = await withdrawalMethodQuery;
    const withdrawalsByMethod = { telebirr: 0, cbebirr: 0, mpesa: 0, manual: 0 };
    if (!wdMethodErr && withdrawalsByMethodData) {
      withdrawalsByMethodData.forEach(w => {
        const type = w.withdrawal_type;
        if (type === 'telebirr') withdrawalsByMethod.telebirr += Number(w.amount);
        else if (type === 'cbebirr') withdrawalsByMethod.cbebirr += Number(w.amount);
        else if (type === 'mpesa') withdrawalsByMethod.mpesa += Number(w.amount);
        else withdrawalsByMethod.manual += Number(w.amount);
      });
    }

    res.json({
      success: true,
      totalDeposits,
      totalWithdrawals,
      totalHouseProfit,
      depositsByMethod,
      withdrawalsByMethod
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Audit endpoints ----------
app.get('/admin/audit', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  const { roomId, userId, eventType, from, to, limit = 200 } = req.query;
  let query = supabase.from('audit_logs').select('*', { count: 'exact' });
  if (roomId) query = query.eq('room_id', roomId);
  if (userId) query = query.eq('user_id', userId);
  if (eventType) query = query.eq('event_type', eventType);
  if (from) query = query.gte('timestamp', from);
  if (to) query = query.lte('timestamp', to);
  query = query.order('timestamp', { ascending: false }).limit(Math.min(parseInt(limit), 1000));
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, logs: data, count });
});

app.get('/admin/audit-summary', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  try {
    const { data: deposits, error: depErr } = await supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    if (depErr) throw depErr;
    const { data: withdrawals, error: wdErr } = await supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    if (wdErr) throw wdErr;
    const { data: rounds, error: rdErr } = await supabase.from('game_rounds').select('house_profit');
    if (rdErr) throw rdErr;
    const totalDeposits = deposits.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalWithdrawals = withdrawals.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);
    res.json({ success: true, totalDeposits, totalWithdrawals, totalHouseProfit });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------- Socket.IO (main namespace) ----------
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  let currentStake = null;
  
  socket.emit('balanceUpdate', users[socket.userId]?.balance || 0);
  
  socket.on('joinLobby', ({ stake }) => {
    if (![10, 20, 30].includes(stake)) return;
    currentStake = stake;
    socket.join(`stake_${stake}`);
    const game = getGame(stake);
    if (game.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((game.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', { stake, startsIn: timeLeft, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });
    } else if (game.status === 'running') {
      socket.emit('gameStarted', { stake, prizePool: game.prizePool, playersCount: game.players.length });
      const player = game.players.find(p => p.telegramId === socket.userId);
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('markedNumbers', player.markedNumbers);
        socket.emit('calledNumbers', game.calledNumbers);
      }
    }
  });
  
  socket.on('selectCardNumber', (cardNumber) => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) {
      socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${game.entryFee} birr.`);
      return;
    }
    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (game.takenCardNumbers.has(num)) { socket.emit('cardSelectionFailed', 'This number is already taken.'); return; }
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId); }
    game.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[num - 1], markedNumbers: [], cardNumber: num, ip: ip };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: num.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', { stake: currentStake, number: num, takenNumbers: Array.from(game.takenCardNumbers) });
    io.to(`stake_${currentStake}`).emit('playersCount', { stake: currentStake, count: game.players.length });
    socket.emit('yourCard', player.card);
    notifyAdminClients();
  });
  
  socket.on('newCardNumber', () => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) { socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${game.entryFee} birr.`); return; }
    const freeNumbers = []; for (let i = 1; i <= 100; i++) if (!game.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) { socket.emit('cardSelectionFailed', 'All numbers are taken.'); return; }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId); }
    game.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum, ip: ip };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: randomNum.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', { stake: currentStake, number: randomNum, takenNumbers: Array.from(game.takenCardNumbers) });
    io.to(`stake_${currentStake}`).emit('playersCount', { stake: currentStake, count: game.players.length });
    socket.emit('yourCard', player.card);
    notifyAdminClients();
  });
  
  socket.on('markNumber', (number) => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'running') return;
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
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'running') return;
    const player = game.players.find(p => p.telegramId === socket.userId);
    if (!player) return;
    const lastCalled = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : null;
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (lastCalled === null || !isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      socket.emit('invalidBingo');
      Audit.bingoRejected(`stake_${currentStake}`, socket.userId, ip, { reason: 'invalid_bingo_call', lastCalled });
      return;
    }
    if (game.winners.find(w => w.telegramId === socket.userId)) return;
    if (game.winningNumber === null) {
      game.winningNumber = lastCalled;
    }
    game.winners.push({ telegramId: socket.userId, username: socket.username });
    Audit.bingoCalled(`stake_${currentStake}`, socket.userId, ip, { cardId: player.cardNumber.toString(), cardGrid: player.card, calledNumber: lastCalled, winType: 'bingo_line' });
    socket.emit('bingoValid');
    if (!game.bingoGraceTimeout && game.winners.length === 1) {
      io.to(`stake_${currentStake}`).emit('multipleBingoPossible', { stake: currentStake, message: 'Bingo claimed! Waiting for other potential winners...' });
      game.bingoGraceTimeout = setTimeout(() => { endGameWithWinners(currentStake); }, 3000);
    }
  });
  
  socket.on('getBalance', async () => { const u = await loadUser(socket.userId, socket.username); socket.emit('balanceUpdate', u.balance); });
});

// ---------- Admin namespace ----------
const adminNamespace = io.of('/admin');
adminNamespace.use((socket, next) => {
  const secret = socket.handshake.query.secret;
  if (secret === process.env.ADMIN_SECRET) return next();
  next(new Error('Unauthorized admin access'));
});

adminNamespace.on('connection', (socket) => {
  console.log('Admin connected to live view');
  socket.emit('admin:playersList', {
    players: getAllPlayersList(),
    gameStatus: {
      10: games[10].status,
      20: games[20].status,
      30: games[30].status
    }
  });
  socket.on('admin:requestPlayers', () => {
    socket.emit('admin:playersList', {
      players: getAllPlayersList(),
      gameStatus: {
        10: games[10].status,
        20: games[20].status,
        30: games[30].status
      }
    });
  });
  
  socket.on('admin:getAllRegisteredPlayers', async () => {
    try {
      const { data: allUsers, error } = await supabase
        .from('users')
        .select('telegram_id, username, balance, telegram_handle');
      if (error) throw error;
      const usersList = (allUsers || []).map(u => ({
        telegramId: u.telegram_id,
        username: u.username,
        balance: u.balance,
        telegram_handle: u.telegram_handle
      }));
      socket.emit('admin:allRegisteredPlayers', { users: usersList });
    } catch (err) {
      console.error('Failed to fetch all registered users:', err);
      socket.emit('admin:allRegisteredPlayers', { users: [] });
    }
  });
});

setInterval(() => {
  notifyAdminClients();
}, 2000);

// Error handler
app.use((err, req, res, next) => { console.error('Unhandled error:', err.message); res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });

// Start all three stakes
resetGame(10);
resetGame(20);
resetGame(30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));
