// ============================================================
//  REQUIRED SQL MIGRATIONS (run in Supabase SQL editor)
// ============================================================
/*
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_deposit_amount NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS invite_stats (
  invite_code TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);

INSERT INTO invite_stats (invite_code) VALUES 
  ('db'), ('mk'), ('hd'), ('ji'), ('ok'), 
  ('ghy'), ('bghu'), ('kil'), ('hg'), ('jkl'), ('jkil')
ON CONFLICT (invite_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_rounds (
  id BIGSERIAL PRIMARY KEY,
  total_entry_fees NUMERIC DEFAULT 0,
  prize_pool NUMERIC DEFAULT 0,
  house_profit NUMERIC DEFAULT 0,
  stake INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
*/
// ============================================================

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
app.get('/users', (req, res) => res.sendFile(path.join(__dirname, 'users.html')));
app.get('/invite-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-dashboard.html')));

app.get('/admin/live-players', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Forbidden: invalid or missing admin secret');
  }
  res.sendFile(path.join(__dirname, 'admin-live-players.html'));
});

// ---------- User cache ----------
const users = {};

// ---------- loadUser with refresh ----------
async function loadUser(telegramId, username, telegramHandle = null, inviteCode = null, refresh = false) {
  const id = String(telegramId);

  if (!refresh && users[id]) {
    console.log(`👤 Cache hit for ${id}`);
    return users[id];
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      users[id] = {
        id,
        username: data.username,
        balance: Number(data.balance),
        telegram_handle: data.telegram_handle,
        referred_by: data.referred_by,
        first_deposit_amount: data.first_deposit_amount || 0
      };
      console.log(`✅ Loaded/refreshed user ${id} (balance: ${users[id].balance})`);
      return users[id];
    } else {
      console.log(`🆕 Creating new user ${id} with inviteCode: ${inviteCode || 'none'}`);
      const newUser = {
        telegram_id: id,
        username: username || 'Player',
        telegram_handle: telegramHandle || null,
        balance: 10,
        referred_by: inviteCode || null,
        first_deposit_amount: 0
      };

      const { error: insertError } = await supabase.from('users').insert(newUser);
      if (insertError) throw insertError;

      if (inviteCode) {
        console.log(`📈 Incrementing invite_stats for code: ${inviteCode}`);
        const { data: inviteData, error: fetchError } = await supabase
          .from('invite_stats')
          .select('count')
          .eq('invite_code', inviteCode)
          .maybeSingle();

        if (fetchError) throw fetchError;

        if (inviteData) {
          const newCount = (inviteData.count || 0) + 1;
          const { error: updateError } = await supabase
            .from('invite_stats')
            .update({ count: newCount })
            .eq('invite_code', inviteCode);
          if (updateError) throw updateError;
          console.log(`✅ Invite count for ${inviteCode} is now ${newCount}`);
        } else {
          const { error: insertInviteError } = await supabase
            .from('invite_stats')
            .insert({ invite_code: inviteCode, count: 1 });
          if (insertInviteError) throw insertInviteError;
          console.log(`✅ Created invite_stats entry for ${inviteCode} with count 1`);
        }
      }

      users[id] = {
        id,
        username: newUser.username,
        balance: 10,
        telegram_handle: newUser.telegram_handle,
        referred_by: newUser.referred_by,
        first_deposit_amount: 0
      };
      return users[id];
    }
  } catch (err) {
    console.error(`❌ loadUser error for ${id}:`, err.message);
    throw err;
  }
}

// ---------- Telegram verification ----------
function verifyTelegram(initData) {
  try {
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
  } catch (err) {
    console.error('❌ Verification error:', err.message);
    return false;
  }
}

app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  console.log('🔍 Raw initData:', initData ? initData.substring(0, 200) + '...' : 'EMPTY');

  if (!initData || !verifyTelegram(initData)) {
    console.log('❌ Verification failed');
    return res.status(403).json({ success: false, error: 'Invalid initData' });
  }

  try {
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get('user'));
    const startParam = params.get('start_param');

    console.log(`📥 start_param: ${startParam || 'none'}`);
    console.log(`👤 User: ${userData.id} (${userData.first_name || userData.username})`);

    const id = String(userData.id);
    const displayName = userData.first_name || userData.username || 'Player';
    const handle = userData.username || null;

    const user = await loadUser(id, displayName, handle, startParam, false);

    req.session.userId = id;
    req.session.save((err) => {
      if (err) {
        console.error('❌ Session save error:', err);
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
  } catch (err) {
    console.error('❌ Auth error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Admin add balance ----------
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const user = await loadUser(strId, 'unknown', null, null, false);
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
  } catch (err) {
    console.error('Error in admin/add-balance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin set balance ----------
app.post('/admin/set-balance', async (req, res) => {
  const { secret, userId, newBalance } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const strId = String(userId);
  const newBal = Number(newBalance);
  if (isNaN(newBal) || newBal < 0) {
    return res.status(400).json({ error: 'Balance must be a non-negative number' });
  }

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', strId)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({ balance: newBal })
      .eq('telegram_id', strId);

    if (updateErr) throw updateErr;

    if (users[strId]) {
      users[strId].balance = newBal;
    } else {
      await loadUser(strId, existing.username, existing.telegram_handle, null, true);
    }

    await Audit.adminAction('ADMIN_SET_BALANCE', 'admin', req.ip, {
      targetUserId: strId,
      oldBalance: existing.balance,
      newBalance: newBal
    });

    const playerSocket = await getSocketByUserId(strId);
    if (playerSocket) {
      playerSocket.emit('balanceUpdate', newBal);
    }

    res.json({ success: true, newBalance: newBal });
  } catch (err) {
    console.error('Error in admin/set-balance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- DELETE USER ----------
app.post('/admin/delete-user', async (req, res) => {
  const { secret, telegramId } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const strId = String(telegramId);
  try {
    const { data: user, error: findErr } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('telegram_id', strId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { error: delErr } = await supabase.from('users').delete().eq('telegram_id', strId);
    if (delErr) throw delErr;

    for (const stake of [100, 20, 30]) {
      const game = games[stake];
      if (!game) continue;
      const playerIndex = game.players.findIndex(p => p.telegramId === strId && !p.isBot);
      if (playerIndex !== -1) {
        const player = game.players[playerIndex];
        if (player.cardNumber) game.takenCardNumbers.delete(player.cardNumber);
        game.players.splice(playerIndex, 1);
        io.to(`stake_${stake}`).emit('cardTaken', {
          stake,
          number: player.cardNumber,
          takenNumbers: Array.from(game.takenCardNumbers)
        });
        broadcastPlayerCount(stake);
        if (game.status === 'running' && game.players.filter(p => !p.isBot).length === 0) {
          clearInterval(game.callInterval);
          endGameWithWinners(stake);
        }
      }
    }

    delete users[strId];
    Audit.adminAction('ADMIN_DELETE_USER', 'admin', req.ip, { targetUserId: strId });
    res.json({ success: true, message: `User ${strId} deleted and removed from active games.` });
  } catch (err) {
    console.error('Error deleting user:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ---------- Multi-stake game states ----------
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

const BOT_NAMES = ['Abebe', 'Almaz', 'Kebede', 'Tigist', 'Sami', 'Hana', 'Biruk', 'Meron', 'Dawit', 'Selam'];

const games = {
  100: createGameState(100),
  20: createGameState(20),
  30: createGameState(30)
};

function getGame(stake) {
  return games[stake];
}

function getAllPlayersList() {
  const allPlayers = [];
  for (const stake of [100, 20, 30]) {
    const game = games[stake];
    game.players.forEach(p => {
      const user = users[p.telegramId];
      allPlayers.push({
        telegramId: p.telegramId,
        username: p.username,
        cardNumber: p.cardNumber,
        stake,
        isBot: p.isBot || false,
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
      100: games[100].status,
      20: games[20].status,
      30: games[30].status
    }
  };
  adminNamespace.emit('admin:playersList', data);
}

// ---------- PUBLIC NAMESPACE ----------
const publicNamespace = io.of('/public');
publicNamespace.on('connection', (socket) => {
  for (const stake of [100, 20, 30]) {
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
  }
});

// ---------- GLOBAL PLAYER COUNT BROADCAST ----------
function broadcastPlayerCount(stake) {
  const game = getGame(stake);
  const count = game.players.length;
  io.to(`stake_${stake}`).emit('playersCount', { stake, count });
  io.emit('playersCount', { stake, count });
  publicNamespace.emit('playersCount', { stake, count });
}

// ---------- BOT LOGIC ----------
function addBotsToGame(stake, game) {
  const botCount = 5;
  const availableNumbers = [];
  for (let i = 1; i <= 100; i++) availableNumbers.push(i);
  // Shuffle
  for (let i = availableNumbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [availableNumbers[i], availableNumbers[j]] = [availableNumbers[j], availableNumbers[i]];
  }
  const usedNumbers = new Set();
  for (const p of game.players) {
    if (p.cardNumber) usedNumbers.add(p.cardNumber);
  }
  // Filter out used numbers
  const freeNumbers = availableNumbers.filter(n => !usedNumbers.has(n));
  for (let i = 0; i < botCount && i < freeNumbers.length; i++) {
    const num = freeNumbers[i];
    game.takenCardNumbers.add(num);
    const botName = BOT_NAMES[i % BOT_NAMES.length];
    const bot = {
      telegramId: `bot_${stake}_${i}_${Date.now()}`,
      username: botName,
      card: game.cardSet[num - 1],
      markedNumbers: [],
      cardNumber: num,
      isBot: true,
      ip: null
    };
    game.players.push(bot);
    // Log card assignment (optional)
    Audit.cardAssigned(`stake_${stake}`, bot.telegramId, null, { cardId: num.toString(), grid: bot.card });
  }
}

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

  // Add bots to the game
  addBotsToGame(stake, game);

  io.to(`stake_${stake}`).emit('lobbyState', { stake, startsIn: 45, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });
  io.emit('lobbyState', { stake, startsIn: 45, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });
  publicNamespace.emit('lobbyState', { stake, startsIn: 45, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });

  broadcastPlayerCount(stake);

  game.lobbyTimer = setTimeout(() => startGame(stake), 45000);
  notifyAdminClients();
}

async function startGame(stake) {
  const game = getGame(stake);
  const toRemove = [];
  // Remove real players with insufficient balance
  for (const p of game.players) {
    if (p.isBot) continue;
    const user = users[p.telegramId];
    if (!user || user.balance < game.entryFee) toRemove.push(p);
  }
  for (const p of toRemove) {
    const idx = game.players.findIndex(pl => pl.telegramId === p.telegramId && !pl.isBot);
    if (idx !== -1) game.players.splice(idx, 1);
    if (p.cardNumber) game.takenCardNumbers.delete(p.cardNumber);
  }
  io.to(`stake_${stake}`).emit('cardTaken', { stake, takenNumbers: Array.from(game.takenCardNumbers) });
  broadcastPlayerCount(stake);
  notifyAdminClients();

  const allPlayers = game.players; // includes bots
  const realPlayers = allPlayers.filter(p => !p.isBot);

  if (realPlayers.length === 0) {
    // No real players, but bots still there – end game with no winner
    game.status = 'ended';
    setTimeout(() => resetGame(stake), 3000);
    notifyAdminClients();
    return;
  }

  // Deduct entry fees from real players only
  for (const p of realPlayers) {
    const user = users[p.telegramId];
    if (user) {
      user.balance -= game.entryFee;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      const playerSocket = await getSocketByUserId(p.telegramId);
      if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
      Audit.adminAction('ENTRY_FEE_PAID', 'system', null, { userId: p.telegramId, amount: game.entryFee, currency: 'ETB', stake });
    }
  }

  // Prize pool includes all players (bots + real)
  const totalEntryFees = game.entryFee * allPlayers.length;
  if (allPlayers.length === 1) {
    game.prizePool = totalEntryFees;
  } else {
    game.prizePool = 0.8 * totalEntryFees;
  }

  game.status = 'running';
  game.calledNumbers = [];
  game.winningNumber = null;
  io.to(`stake_${stake}`).emit('gameStarted', { stake, prizePool: game.prizePool, playersCount: allPlayers.length });
  notifyAdminClients();
  startCalling(stake);
}

async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

// ---- Bot bingo claim logic ----
function handleBotBingo(stake, lastCalled) {
  const game = getGame(stake);
  if (game.status !== 'running') return;
  for (const player of game.players) {
    if (!player.isBot) continue;
    // Check if this bot has a bingo line with lastCalled
    if (isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      // Check if already a winner
      if (game.winners.find(w => w.telegramId === player.telegramId)) continue;
      // Add to winners
      game.winners.push({ telegramId: player.telegramId, username: player.username, isBot: true });
      // Start grace period if not already
      if (!game.bingoGraceTimeout && game.winners.length === 1) {
        io.to(`stake_${stake}`).emit('multipleBingoPossible', { stake, message: 'Bingo claimed! Waiting for other potential winners...' });
        game.bingoGraceTimeout = setTimeout(() => { endGameWithWinners(stake); }, 3000);
      }
    }
  }
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

    // ---- Mark bots' numbers automatically ----
    for (const player of game.players) {
      if (player.isBot) {
        const flatCard = player.card.flat();
        if (flatCard.includes(number) && !player.markedNumbers.includes(number)) {
          player.markedNumbers.push(number);
        }
      }
    }

    // ---- After marking, check if any bot has a bingo and claim ----
    // Use a small random delay to simulate human reaction (1-3 seconds)
    const delay = 1000 + Math.random() * 2000;
    setTimeout(() => {
      handleBotBingo(stake, number);
    }, delay);
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

  // Prize pool already computed based on all players
  const allPlayers = game.players;
  const totalEntryFees = game.entryFee * allPlayers.length;
  const houseProfit = totalEntryFees - game.prizePool;

  try {
    const { error } = await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees,
      prize_pool: game.prizePool,
      house_profit: houseProfit,
      stake
    });
    if (error) {
      console.error(`❌ Failed to insert game_round for stake ${stake}:`, error);
    } else {
      console.log(`✅ Game round recorded for stake ${stake} (entry: ${totalEntryFees}, prize: ${game.prizePool}, profit: ${houseProfit})`);
    }
  } catch (err) {
    console.error(`❌ Exception inserting game_round for stake ${stake}:`, err.message);
  }

  // Filter out bot winners for payout (only real players get paid)
  const realWinners = game.winners.filter(w => !w.isBot);
  if (realWinners.length > 0) {
    const prizeEach = Math.floor(game.prizePool / realWinners.length);
    for (const w of realWinners) {
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
          totalWinners: game.winners.length, // total winners including bots
          stake
        });
        detectRapidWins(`stake_${stake}`, w.telegramId, null);
      }
    }

    const ipCounts = {};
    realWinners.forEach(w => {
      const player = game.players.find(p => p.telegramId === w.telegramId);
      const ip = player ? player.ip : null;
      if (ip) ipCounts[ip] = (ipCounts[ip] || 0) + 1;
    });
    Object.entries(ipCounts).forEach(([ip, count]) => {
      if (count >= 3) {
        Audit.suspicious(`stake_${stake}`, 'system', ip, {
          detectionSource: 'multiple_winners_same_ip',
          reason: `${count} winners from IP ${ip}`,
          evidence: { winners: realWinners.map(w => w.telegramId) }
        });
      }
    });

    // Include all winners (bots + real) in the gameEnded event
    const allWinnerNames = game.winners.map(w => w.username);
    io.to(`stake_${stake}`).emit('gameEnded', {
      stake,
      winner: allWinnerNames.length === 1 ? allWinnerNames[0] : `${allWinnerNames.length} winners`,
      winners: allWinnerNames,
      prizeEach: prizeEach,
      totalPrize: game.prizePool,
      winnerCount: allWinnerNames.length,
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

// ---------- Deposit endpoints (SMS proof removed) ----------
app.post('/api/request-deposit', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { phone, amount, payment_type } = req.body;

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });

  try {
    const user = await loadUser(userId, null, null, null, false);
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

    if (error) throw error;

    await Audit.depositInitiated(userId, req.ip, {
      transactionId: data.id.toString(),
      amount: amt,
      currency: 'ETB',
      method: payment_type
    });

    res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB via ${payment_type} submitted.` });
  } catch (err) {
    console.error('Deposit request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The rest of the endpoints (admin deposits, withdrawals, stats, referral, audit) remain unchanged.
// They are identical to your previous version, so we skip repeating them here for brevity.
// Ensure you include all other endpoints (admin/process-deposit, admin/withdrawals, etc.)

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

  for (const stake of [100, 20, 30]) {
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
  }

  socket.on('joinLobby', ({ stake }) => {
    if (![100, 20, 30].includes(stake)) return;
    currentStake = stake;
    socket.join(`stake_${stake}`);
    const game = getGame(stake);

    socket.emit('playersCount', { stake, count: game.players.length });

    if (game.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((game.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', { stake, startsIn: timeLeft, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });
    } else if (game.status === 'running') {
      socket.emit('gameStarted', { stake, prizePool: game.prizePool, playersCount: game.players.length });
      const player = game.players.find(p => p.telegramId === socket.userId && !p.isBot);
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
    const existing = game.players.find(p => p.telegramId === socket.userId && !p.isBot);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId || p.isBot); }
    game.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[num - 1], markedNumbers: [], cardNumber: num, ip: ip, isBot: false };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: num.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', { stake: currentStake, number: num, takenNumbers: Array.from(game.takenCardNumbers) });
    broadcastPlayerCount(currentStake);
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
    const existing = game.players.find(p => p.telegramId === socket.userId && !p.isBot);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId || p.isBot); }
    game.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum, ip: ip, isBot: false };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: randomNum.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', { stake: currentStake, number: randomNum, takenNumbers: Array.from(game.takenCardNumbers) });
    broadcastPlayerCount(currentStake);
    socket.emit('yourCard', player.card);
    notifyAdminClients();
  });

  socket.on('markNumber', (number) => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'running') return;
    const player = game.players.find(p => p.telegramId === socket.userId && !p.isBot);
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
    const player = game.players.find(p => p.telegramId === socket.userId && !p.isBot);
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
    const winner = { telegramId: socket.userId, username: socket.username, isBot: false };
    game.winners.push(winner);
    Audit.bingoCalled(`stake_${currentStake}`, socket.userId, ip, { cardId: player.cardNumber.toString(), cardGrid: player.card, calledNumber: lastCalled, winType: 'bingo_line' });
    socket.emit('bingoValid');
    if (!game.bingoGraceTimeout && game.winners.length === 1) {
      io.to(`stake_${currentStake}`).emit('multipleBingoPossible', { stake: currentStake, message: 'Bingo claimed! Waiting for other potential winners...' });
      game.bingoGraceTimeout = setTimeout(() => { endGameWithWinners(currentStake); }, 3000);
    }
  });

  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username, null, null, true);
    socket.emit('balanceUpdate', u.balance);
  });
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
      100: games[100].status,
      20: games[20].status,
      30: games[30].status
    }
  });
  socket.on('admin:requestPlayers', () => {
    socket.emit('admin:playersList', {
      players: getAllPlayersList(),
      gameStatus: {
        100: games[100].status,
        20: games[20].status,
        30: games[30].status
      }
    });
  });

  socket.on('admin:getAllRegisteredPlayers', async () => {
    try {
      const { data: allUsers, error } = await supabase
        .from('users')
        .select('telegram_id, username, balance, telegram_handle, referred_by, first_deposit_amount');
      if (error) throw error;
      const usersList = (allUsers || []).map(u => ({
        telegramId: u.telegram_id,
        username: u.username,
        balance: u.balance,
        telegram_handle: u.telegram_handle,
        referred_by: u.referred_by,
        first_deposit_amount: u.first_deposit_amount || 0
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
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start all three stakes (100, 20, 30)
resetGame(100);
resetGame(20);
resetGame(30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));
