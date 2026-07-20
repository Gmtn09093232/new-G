// ============================================================
//  REQUIRED SQL MIGRATIONS (run in Supabase SQL editor)
// ============================================================
/*
-- Add admin columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_deposit_amount NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_admin_name TEXT;

-- Create invite_stats table
CREATE TABLE IF NOT EXISTS invite_stats (
  invite_code TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);

INSERT INTO invite_stats (invite_code) VALUES 
  ('db'), ('mk'), ('hd'), ('ji'), ('ok'), 
  ('ghy'), ('bghu'), ('kil'), ('hg'), ('jkl'), ('jkil')
ON CONFLICT (invite_code) DO NOTHING;

-- Create game_rounds table
CREATE TABLE IF NOT EXISTS game_rounds (
  id BIGSERIAL PRIMARY KEY,
  total_entry_fees NUMERIC DEFAULT 0,
  prize_pool NUMERIC DEFAULT 0,
  house_profit NUMERIC DEFAULT 0,
  stake INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add SMS proof columns to deposit_requests
ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS transaction_reference TEXT;
ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS proof_text TEXT;
ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS admin_id BIGINT;
ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS assigned_deposit_number TEXT;

-- Add admin_id to withdrawal_requests
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS admin_id BIGINT;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS assigned_admin_name TEXT;

-- Create admins table
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  deposit_number TEXT NOT NULL,
  payment_type TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_admin_id ON users(admin_id);
CREATE INDEX IF NOT EXISTS idx_deposits_admin_id ON deposit_requests(admin_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_admin_id ON withdrawal_requests(admin_id);

-- Insert sample admins (replace with real data)
INSERT INTO admins (phone, name, deposit_number, payment_type, secret_key) VALUES 
  ('0924839730', 'Admin 1', '0924839730', 'telebirr', 'admin_secret_1'),
  ('0912345678', 'Admin 2', '0912345678', 'telebirr', 'admin_secret_2'),
  ('0922222222', 'Admin 3', '1000123456789', 'cbebirr', 'admin_secret_3')
ON CONFLICT (phone) DO NOTHING;
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

// ---------- Admin Management ----------
const adminCache = {};

async function loadAdmin(secretKey) {
  if (adminCache[secretKey] && (Date.now() - adminCache[secretKey].cachedAt < 60000)) {
    return adminCache[secretKey];
  }
  
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('*')
      .eq('secret_key', secretKey)
      .eq('is_active', true)
      .maybeSingle();
    
    if (error) throw error;
    if (data) {
      adminCache[secretKey] = { ...data, cachedAt: Date.now() };
      return adminCache[secretKey];
    }
    return null;
  } catch (err) {
    console.error('Error loading admin:', err.message);
    return null;
  }
}

async function getAllAdmins() {
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('*')
      .eq('is_active', true)
      .order('name');
    
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error fetching admins:', err.message);
    return [];
  }
}

async function getAdminPlayers(adminId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('admin_id', adminId)
      .order('username');
    
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error fetching admin players:', err.message);
    return [];
  }
}

async function getAdminPlayerCount(adminId) {
  try {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('admin_id', adminId);
    
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.error('Error counting admin players:', err.message);
    return 0;
  }
}

async function getAdminDeposits(adminId, status = 'approved') {
  try {
    const { data, error } = await supabase
      .from('deposit_requests')
      .select('amount')
      .eq('admin_id', adminId)
      .eq('status', status);
    
    if (error) throw error;
    return data.reduce((sum, d) => sum + Number(d.amount), 0);
  } catch (err) {
    console.error('Error fetching admin deposits:', err.message);
    return 0;
  }
}

// ---------- Static endpoints ----------
app.get('/api/deposit-accounts', async (req, res) => {
  try {
    const admins = await getAllAdmins();
    
    // Group by payment type
    const accounts = {
      telebirr: [],
      cbebirr: [],
      mpesa: []
    };
    
    admins.forEach(admin => {
      if (admin.payment_type && accounts[admin.payment_type]) {
        accounts[admin.payment_type].push({
          number: admin.deposit_number,
          name: admin.name,
          adminId: admin.id
        });
      }
    });
    
    res.json({ success: true, accounts });
  } catch (err) {
    console.error('Error fetching deposit accounts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin-phone', (req, res) => { res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }); });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'live.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/users', (req, res) => res.sendFile(path.join(__dirname, 'users.html')));
app.get('/invite-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-dashboard.html')));
app.get('/bots', (req, res) => res.sendFile(path.join(__dirname, 'bots.html')));
app.get('/admin-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));

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
async function loadUser(telegramId, username, telegramHandle = null, inviteCode = null, refresh = false, adminId = null) {
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
        first_deposit_amount: data.first_deposit_amount || 0,
        admin_id: data.admin_id,
        assigned_admin_name: data.assigned_admin_name
      };
      console.log(`✅ Loaded/refreshed user ${id} (balance: ${users[id].balance}, admin: ${data.assigned_admin_name || 'none'})`);
      return users[id];
    } else {
      console.log(`🆕 Creating new user ${id} with adminId: ${adminId || 'none'}`);
      
      let adminName = null;
      if (adminId) {
        const { data: adminData, error: adminErr } = await supabase
          .from('admins')
          .select('name')
          .eq('id', adminId)
          .maybeSingle();
        
        if (!adminErr && adminData) {
          adminName = adminData.name;
        }
      }
      
      const newUser = {
        telegram_id: id,
        username: username || 'Player',
        telegram_handle: telegramHandle || null,
        balance: 10,
        referred_by: inviteCode || null,
        first_deposit_amount: 0,
        admin_id: adminId || null,
        assigned_admin_name: adminName
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
        first_deposit_amount: 0,
        admin_id: newUser.admin_id,
        assigned_admin_name: newUser.assigned_admin_name
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
        telegram_handle: user.telegram_handle,
        admin_id: user.admin_id,
        assigned_admin_name: user.assigned_admin_name
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

// Admin set balance exact
app.post('/admin/set-balance', async (req, res) => {
  const { secret, userId, newBalance } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(userId);
  const newBal = Number(newBalance);
  if (isNaN(newBal) || newBal < 0) return res.status(400).json({ error: 'Balance must be a non-negative number' });
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', strId)
      .maybeSingle();
    if (fetchErr || !existing) return res.status(404).json({ error: 'User not found' });
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
    if (playerSocket) playerSocket.emit('balanceUpdate', newBal);
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
      const playerIndex = game.players.findIndex(p => p.telegramId === strId);
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
        if (game.status === 'running' && game.players.length === 0) {
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
    winningNumber: null,
    botTimeouts: [],
    bot3Added: false,
    forceActive: false,
    forcedBotId: null,
    forcedCallCounter: 0
  };
}

const games = {
  100: createGameState(100),
  20: createGameState(20),
  30: createGameState(30)
};

// ======================== BOT PLAYERS (only for stake 20) ========================
const BOT_IDS = ['1945854', '8696548', '78963521', '45896872', '1236584'];
const botBalances = new Map();
BOT_IDS.forEach((id) => botBalances.set(id, 1000));

const ETHIOPIAN_MALE_NAMES = [
  'Abe', 'Alex', 'mekia', 'Dawit', 'Fikru', 'Girma', 'Haile', 'zid',
  'sura cr7', 'nega', 'Mekonnen', 'Nebiyu', 'baye', 'Robel', 'teddy',
  'Tadesse', 'Wondia', 'Yared', 'Zemenu', 'Birukee', 'bura', 'Ermias',
  'Fitsum', 'shaki', 'belaya', 'Mulugeta', 'Nati', 'dera',
  'Tekle', 'Worku', 'jhone', 'Aman', 'Belete', 'Daniel', 'Endalk',
  'Gashaw', 'Habtia', 'kassish', 'Lul', 'Mengistu', 'Mulu',
  '@', 'abela', 'Tesfaye', 'Wolde'
];

function getRandomMaleEthiopianName() {
  return ETHIOPIAN_MALE_NAMES[Math.floor(Math.random() * ETHIOPIAN_MALE_NAMES.length)];
}

let gameCounter = 0;
const botLastWinGame = new Map();
BOT_IDS.forEach(id => botLastWinGame.set(id, 0));
const forceBotWinNextGame = { 20: false, 100: false, 30: false };
let globalForcedBotId = null;
let botGameHistory = [];
const BOT_NAME_REFRESH_MS = 12 * 60 * 60 * 1000;
const botNameAssignments = new Map();

function getBotName(botId) {
  const now = Date.now();
  const entry = botNameAssignments.get(botId);
  if (entry && (now - entry.assignedAt) < BOT_NAME_REFRESH_MS) {
    return entry.name;
  }
  const newName = getRandomMaleEthiopianName();
  botNameAssignments.set(botId, { name: newName, assignedAt: now });
  console.log(`🆕 Bot ${botId} assigned new name: ${newName} (valid for 12h)`);
  return newName;
}

function addSingleBotToGame(botId, stake) {
  if (stake !== 20) return false;
  const game = getGame(stake);
  if (!game || game.status !== 'lobby') return false;
  if (game.players.find(p => p.telegramId === botId)) return false;
  const balance = botBalances.get(botId) || 0;
  if (balance < game.entryFee) {
    console.log(`⚠️ Bot ${botId} insufficient balance (${balance}) to join stake ${stake}`);
    return false;
  }
  const availableNumbers = [];
  for (let i = 1; i <= 100; i++) {
    if (!game.takenCardNumbers.has(i)) availableNumbers.push(i);
  }
  if (availableNumbers.length === 0) {
    console.log('⚠️ No available numbers for bot');
    return false;
  }
  const cardNumber = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];
  const card = game.cardSet[cardNumber - 1];
  const botName = getBotName(botId);
  const botPlayer = {
    telegramId: botId,
    username: botName,
    card: card,
    markedNumbers: [],
    cardNumber: cardNumber,
    ip: '127.0.0.1',
    isBot: true,
    hasCalledBingo: false
  };
  game.players.push(botPlayer);
  game.takenCardNumbers.add(cardNumber);
  io.to(`stake_${stake}`).emit('cardTaken', {
    stake,
    number: cardNumber,
    takenNumbers: Array.from(game.takenCardNumbers)
  });
  broadcastPlayerCount(stake);
  notifyAdminClients();
  console.log(`🤖 Bot ${botId} joined stake ${stake} with card ${cardNumber}`);
  return true;
}

function removeBotFromGame(botId, stake) {
  const game = getGame(stake);
  if (!game) return false;
  const idx = game.players.findIndex(p => p.telegramId === botId);
  if (idx === -1) return false;
  const player = game.players[idx];
  if (player.cardNumber) game.takenCardNumbers.delete(player.cardNumber);
  game.players.splice(idx, 1);
  io.to(`stake_${stake}`).emit('cardTaken', {
    stake,
    number: player.cardNumber,
    takenNumbers: Array.from(game.takenCardNumbers)
  });
  broadcastPlayerCount(stake);
  notifyAdminClients();
  console.log(`🤖 Bot ${botId} removed from stake ${stake}`);
  return true;
}

function checkAndAddThirdBot(stake) {
  if (stake !== 20) return;
  const game = getGame(stake);
  if (!game || game.status !== 'lobby') return;
  if (game.bot3Added) return;
  const realPlayers = game.players.filter(p => !p.isBot);
  if (realPlayers.length >= 3) {
    game.bot3Added = true;
    setTimeout(() => {
      if (game.status !== 'lobby') return;
      if (game.players.find(p => p.telegramId === BOT_IDS[2])) return;
      addSingleBotToGame(BOT_IDS[2], stake);
      console.log(`🤖 Third bot (${BOT_IDS[2]}) added because 3 real players joined.`);
    }, 500);
  }
}

function updateBotsOnNumber(stake, number) {
  if (stake !== 20) return;
  const game = getGame(stake);
  if (game.status !== 'running') return;
  const bots = game.players.filter(p => p.isBot);
  for (const bot of bots) {
    const flat = bot.card.flat();
    if (flat.includes(number) && !bot.markedNumbers.includes(number)) {
      bot.markedNumbers.push(number);
    }
    const lastCalled = game.calledNumbers[game.calledNumbers.length - 1];
    if (lastCalled === undefined) continue;
    if (isBingoValidOnLastCall(bot.card, bot.markedNumbers, lastCalled)) {
      if (!bot.hasCalledBingo && !game.winners.find(w => w.telegramId === bot.telegramId)) {
        bot.hasCalledBingo = true;
        const delay = Math.random() < 0.2 ? 0 : 500 + Math.random() * 1500;
        setTimeout(() => {
          if (game.status !== 'running') return;
          if (game.winners.find(w => w.telegramId === bot.telegramId)) return;
          handleBingoClaim(bot.telegramId, stake);
        }, delay);
      }
    }
  }
}

function handleBingoClaim(telegramId, stake, force = false) {
  const game = getGame(stake);
  if (game.status !== 'running') return;
  const player = game.players.find(p => p.telegramId === telegramId);
  if (!player) return;
  if (game.winners.find(w => w.telegramId === telegramId)) return;

  if (!force) {
    const lastCalled = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : null;
    if (lastCalled === null) return;
    if (!isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) return;
  }

  if (game.winningNumber === null) {
    game.winningNumber = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : 1;
  }
  game.winners.push({
    telegramId,
    username: player.username,
    isBot: player.isBot || false,
    isForced: force
  });

  if (!player.isBot && !force) {
    Audit.bingoCalled(`stake_${stake}`, telegramId, player.ip || null, { 
      cardId: player.cardNumber, 
      cardGrid: player.card, 
      calledNumber: game.winningNumber, 
      winType: 'bingo_line' 
    });
  }

  if (!game.bingoGraceTimeout) {
    io.to(`stake_${stake}`).emit('multipleBingoPossible', { stake, message: 'Bingo claimed! Waiting for other potential winners...' });
    game.bingoGraceTimeout = setTimeout(() => {
      endGameWithWinners(stake);
    }, 3000);
  }
}

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
        telegram_handle: user ? user.telegram_handle : null,
        isBot: p.isBot || false
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

function broadcastPlayerCount(stake) {
  const game = getGame(stake);
  const count = game.players.length;
  io.to(`stake_${stake}`).emit('playersCount', { stake, count });
  io.emit('playersCount', { stake, count });
  publicNamespace.emit('playersCount', { stake, count });
}

function resetGame(stake) {
  const game = getGame(stake);
  clearInterval(game.callInterval);
  clearTimeout(game.lobbyTimer);
  clearTimeout(game.bingoGraceTimeout);
  for (const timeout of game.botTimeouts) {
    clearTimeout(timeout);
  }
  game.botTimeouts = [];
  game.bot3Added = false;
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

  if (stake === 20 && forceBotWinNextGame[20]) {
    game.forceActive = true;
    game.forcedBotId = globalForcedBotId;
    game.forcedCallCounter = 0;
    console.log(`⏳ Forced win active for bot ${game.forcedBotId} on 21st call.`);
  } else {
    game.forceActive = false;
    game.forcedBotId = null;
  }

  if (stake === 20) {
    const scheduleBotAtRemaining = (botIndex, remainingSeconds) => {
      if (botIndex >= BOT_IDS.length) return;
      const absoluteTime = game.lobbyEndTime - remainingSeconds * 1000;
      const delay = absoluteTime - Date.now();
      if (delay <= 0) return;
      const timeout = setTimeout(() => {
        if (game.status !== 'lobby') return;
        const botId = BOT_IDS[botIndex];
        if (game.players.find(p => p.telegramId === botId)) return;
        addSingleBotToGame(botId, stake);
      }, delay);
      game.botTimeouts.push(timeout);
    };

    scheduleBotAtRemaining(0, 41);
    scheduleBotAtRemaining(1, 39);
  }

  io.to(`stake_${stake}`).emit('lobbyState', { 
    stake, 
    startsIn: 45, 
    takenNumbers: Array.from(game.takenCardNumbers), 
    playersCount: game.players.length 
  });
  io.emit('lobbyState', { 
    stake, 
    startsIn: 45, 
    takenNumbers: Array.from(game.takenCardNumbers), 
    playersCount: game.players.length 
  });
  publicNamespace.emit('lobbyState', { 
    stake, 
    startsIn: 45, 
    takenNumbers: Array.from(game.takenCardNumbers), 
    playersCount: game.players.length 
  });
  
  broadcastPlayerCount(stake);
  game.lobbyTimer = setTimeout(() => startGame(stake), 45000);
  notifyAdminClients();
}

async function startGame(stake) {
  const game = getGame(stake);
  for (const timeout of game.botTimeouts) {
    clearTimeout(timeout);
  }
  game.botTimeouts = [];

  const toRemove = [];
  for (const p of game.players) {
    if (p.isBot) {
      const bal = botBalances.get(p.telegramId) || 0;
      if (bal < game.entryFee) {
        toRemove.push(p);
      }
    } else {
      const user = users[p.telegramId];
      if (!user || user.balance < game.entryFee) toRemove.push(p);
    }
  }
  for (const p of toRemove) {
    const idx = game.players.findIndex(pl => pl.telegramId === p.telegramId);
    if (idx !== -1) {
      game.players.splice(idx, 1);
      if (p.cardNumber) game.takenCardNumbers.delete(p.cardNumber);
    }
  }
  io.to(`stake_${stake}`).emit('cardTaken', { stake, takenNumbers: Array.from(game.takenCardNumbers) });
  broadcastPlayerCount(stake);
  notifyAdminClients();

  if (game.players.length === 0) {
    game.status = 'ended';
    setTimeout(() => resetGame(stake), 3000);
    notifyAdminClients();
    return;
  }

  for (const p of game.players) {
    if (p.isBot) {
      const bal = botBalances.get(p.telegramId) || 0;
      botBalances.set(p.telegramId, bal - game.entryFee);
      console.log(`💸 Bot ${p.telegramId} paid entry fee ${game.entryFee}, balance now ${botBalances.get(p.telegramId)}`);
      continue;
    }
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
  for (const p of game.players) {
    if (p.isBot) p.hasCalledBingo = false;
  }
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
  let callCount = 0;
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
    callCount++;
    io.to(`stake_${stake}`).emit('numberCalled', { stake, number, calledNumbers: game.calledNumbers });
    Audit.numberDrawn(`stake_${stake}`, { drawnNumber: number, drawIndex: game.calledNumbers.length, timestamp: new Date().toISOString() });

    if (stake === 20 && game.forceActive && callCount === 21) {
      if (game.winners.length === 0) {
        const forcedBot = game.players.find(p => p.telegramId === game.forcedBotId);
        if (forcedBot) {
          const flat = forcedBot.card.flat();
          if (flat.includes(number) && !forcedBot.markedNumbers.includes(number)) {
            forcedBot.markedNumbers.push(number);
          }
          handleBingoClaim(game.forcedBotId, stake, true);
          console.log(`🤖 Forced bot ${game.forcedBotId} claimed bingo on 21st call.`);
          game.forceActive = false;
          forceBotWinNextGame[20] = false;
          return;
        }
      } else {
        game.forceActive = false;
        forceBotWinNextGame[20] = false;
      }
    }

    if (stake === 20) {
      updateBotsOnNumber(stake, number);
    }
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

  gameCounter++;

  if (stake === 20) {
    const realWinners = game.winners.filter(w => !w.isBot);
    const botWinners = game.winners.filter(w => w.isBot);

    if (realWinners.length > 0 && botWinners.length === 0) {
      forceBotWinNextGame[20] = true;
      const eligibleBots = game.players.filter(p => p.isBot);
      if (eligibleBots.length > 0) {
        const forcedBot = eligibleBots.reduce((a, b) =>
          (botBalances.get(a.telegramId) || 0) < (botBalances.get(b.telegramId) || 0) ? a : b
        );
        globalForcedBotId = forcedBot.telegramId;
        console.log(`🤖 Next game will force bot ${globalForcedBotId} to win on the 21st call.`);
      } else {
        globalForcedBotId = null;
      }
    }

    if (botWinners.length > 0) {
      forceBotWinNextGame[20] = false;
      console.log(`🤖 Bot won naturally in stake 20, forceBotWinNextGame[20] = false`);
    }
  }

  const totalEntryFees = game.players.length * game.entryFee;
  const houseProfit = totalEntryFees - game.prizePool;
  try {
    const { error } = await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees,
      prize_pool: game.prizePool,
      house_profit: houseProfit,
      stake
    });
    if (error) console.error(`❌ Failed to insert game_round for stake ${stake}:`, error);
    else console.log(`✅ Game round recorded for stake ${stake} (entry: ${totalEntryFees}, prize: ${game.prizePool}, profit: ${houseProfit})`);
  } catch (err) {
    console.error(`❌ Exception inserting game_round for stake ${stake}:`, err.message);
  }

  if (stake === 20) {
    const botsInGame = game.players.filter(p => p.isBot);
    for (const bot of botsInGame) {
      const winner = game.winners.find(w => w.telegramId === bot.telegramId);
      const prizeWon = winner ? (game.prizePool / game.winners.length) : 0;
      botGameHistory.push({
        botId: bot.telegramId,
        gameNumber: gameCounter,
        date: new Date().toISOString(),
        stake: game.entryFee,
        prizeWon: prizeWon
      });
    }
  }

  const realWinnersFinal = game.winners.filter(w => !w.isBot);
  if (realWinnersFinal.length > 0) {
    game.winners = game.winners.filter(w => !w.isBot || w.isForced);
  }

  if (game.winners.length > 0) {
    const finalRealWinners = game.winners.filter(w => !w.isBot);
    const finalBotWinners = game.winners.filter(w => w.isBot);

    let prizeEachReal = 0;
    let prizeEachBot = 0;

    if (finalRealWinners.length > 0) {
      prizeEachReal = Math.floor(game.prizePool / finalRealWinners.length);
      prizeEachBot = 0;
    } else {
      prizeEachBot = Math.floor(game.prizePool / finalBotWinners.length);
    }

    for (const w of finalRealWinners) {
      const user = users[w.telegramId];
      if (user) {
        user.balance += prizeEachReal;
        await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', w.telegramId);
        const winnerSocket = await getSocketByUserId(w.telegramId);
        if (winnerSocket) winnerSocket.emit('balanceUpdate', user.balance);
        Audit.winPaidOut(`stake_${stake}`, w.telegramId, null, {
          amount: prizeEachReal,
          currency: 'ETB',
          totalPrizePool: game.prizePool,
          totalWinners: game.winners.length,
          stake
        });
        detectRapidWins(`stake_${stake}`, w.telegramId, null);
      }
    }

    for (const w of finalBotWinners) {
      const bal = botBalances.get(w.telegramId) || 0;
      botBalances.set(w.telegramId, bal + prizeEachBot);
      console.log(`🏆 Bot ${w.telegramId} won ${prizeEachBot} (balance now ${botBalances.get(w.telegramId)})`);
    }

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
      prizeEach: finalRealWinners.length > 0 ? prizeEachReal : prizeEachBot,
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

// ======================== BOT ADMIN ENDPOINTS ========================

app.get('/admin/bots-status', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const botData = BOT_IDS.map(id => {
    const balance = botBalances.get(id) || 0;
    const lastWin = botLastWinGame.get(id) || 0;
    const game = getGame(20);
    const player = game.players.find(p => p.telegramId === id);
    return {
      id,
      username: player ? player.username : 'not in game',
      balance,
      lastWinGame: lastWin,
      inGame: !!player,
      cardNumber: player ? player.cardNumber : null
    };
  });
  res.json({ success: true, bots: botData, currentGame: gameCounter });
});

app.post('/admin/bot-reset-balance', async (req, res) => {
  const { secret, botId, newBalance } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!BOT_IDS.includes(botId)) return res.status(400).json({ error: 'Invalid bot ID' });
  const bal = Number(newBalance);
  if (isNaN(bal) || bal < 0) return res.status(400).json({ error: 'Balance must be non-negative' });
  botBalances.set(botId, bal);
  Audit.adminAction('BOT_BALANCE_RESET', 'admin', req.ip, { botId, newBalance: bal });
  res.json({ success: true, newBalance: bal });
});

app.post('/admin/bot-force-win', async (req, res) => {
  const { secret, botId } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!BOT_IDS.includes(botId)) return res.status(400).json({ error: 'Invalid bot ID' });
  const game = getGame(20);
  if (!game || game.status !== 'running') {
    return res.status(400).json({ error: 'Game is not running' });
  }
  const player = game.players.find(p => p.telegramId === botId);
  if (!player) {
    return res.status(400).json({ error: 'Bot is not in the current game' });
  }
  if (game.winners.find(w => w.telegramId === botId)) {
    return res.status(400).json({ error: 'Bot already won this game' });
  }
  if (game.winningNumber === null) {
    game.winningNumber = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : 1;
  }
  game.winners.push({
    telegramId: botId,
    username: player.username,
    isBot: true,
    isForced: true
  });
  botLastWinGame.set(botId, gameCounter);
  Audit.adminAction('BOT_FORCED_WIN', 'admin', req.ip, { botId, game: gameCounter });
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;
  endGameWithWinners(20);
  res.json({ success: true, message: `Bot ${botId} forced to win. Game ending.` });
});

app.get('/admin/bot-history', (req, res) => {
  const { secret, from, to } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  let history = botGameHistory;
  if (from) {
    const fromDate = new Date(from);
    fromDate.setHours(0,0,0,0);
    history = history.filter(entry => new Date(entry.date) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23,59,59,999);
    history = history.filter(entry => new Date(entry.date) <= toDate);
  }
  res.json({ success: true, history, from: from || null, to: to || null });
});

app.get('/admin-bots', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-bots.html'));
});
app.get('/admin-bot-stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-bot-stats.html'));
});

// ---------- Deposit endpoints ----------
app.post('/api/request-deposit', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  
  const { phone, amount, payment_type, transaction_reference, proof_text, admin_id } = req.body;
  const amt = Number(amount);
  
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  if (!admin_id) return res.status(400).json({ error: 'Please select a deposit account' });
  
  try {
    // Verify the admin exists
    const { data: admin, error: adminErr } = await supabase
      .from('admins')
      .select('id, deposit_number, name')
      .eq('id', admin_id)
      .eq('is_active', true)
      .maybeSingle();
    
    if (adminErr || !admin) {
      return res.status(400).json({ error: 'Invalid deposit account selected' });
    }
    
    const user = await loadUser(userId, null, null, null, false);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // If user doesn't have an admin assigned, assign this admin to them
    if (!user.admin_id) {
      await supabase
        .from('users')
        .update({ 
          admin_id: admin.id, 
          assigned_admin_name: admin.name 
        })
        .eq('telegram_id', userId);
      
      // Update cache
      if (users[userId]) {
        users[userId].admin_id = admin.id;
        users[userId].assigned_admin_name = admin.name;
      }
    }
    
    const { data, error } = await supabase.from('deposit_requests').insert({
      telegram_id: userId,
      username: user.username,
      amount: amt,
      status: 'pending',
      phone: phone || null,
      payment_type,
      transaction_reference: transaction_reference || null,
      proof_text: proof_text || null,
      admin_id: admin.id,
      assigned_deposit_number: admin.deposit_number
    }).select().single();
    
    if (error) throw error;
    
    Audit.depositInitiated(userId, req.ip, {
      transactionId: data.id.toString(),
      amount: amt,
      currency: 'ETB',
      method: payment_type,
      adminId: admin.id,
      adminName: admin.name,
      adminNumber: admin.deposit_number,
      transactionReference: transaction_reference,
      proofLength: proof_text ? proof_text.length : 0
    });
    
    res.json({ 
      success: true, 
      requestId: data.id, 
      message: `Deposit request of ${amt} ETB via ${payment_type} submitted to ${admin.name}.`,
      adminName: admin.name,
      adminNumber: admin.deposit_number
    });
  } catch (err) {
    console.error('Deposit request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    // Get only deposits for this admin
    const { data, error } = await supabase
      .from('deposit_requests')
      .select('*')
      .eq('status', 'pending')
      .eq('admin_id', admin.id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    
    // Get admin stats
    const playerCount = await getAdminPlayerCount(admin.id);
    const totalDeposits = await getAdminDeposits(admin.id);
    const approvedToday = await getAdminDeposits(admin.id, 'approved');
    
    res.json({ 
      requests: data,
      admin: {
        id: admin.id,
        name: admin.name,
        phone: admin.phone,
        deposit_number: admin.deposit_number
      },
      stats: {
        playerCount,
        totalDeposits,
        pendingCount: data.length,
        approvedToday
      }
    });
  } catch (err) {
    console.error('Error fetching deposits:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    const { data: reqData, error: fetchErr } = await supabase
      .from('deposit_requests')
      .select('*')
      .eq('id', requestId)
      .eq('admin_id', admin.id)
      .single();
    
    if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found or not assigned to you' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    
    if (action === 'approve') {
      const user = await loadUser(reqData.telegram_id, null, null, null, false);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      user.balance += reqData.amount;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
      await supabase.from('deposit_requests').update({ 
        status: 'approved', 
        processed_at: new Date().toISOString() 
      }).eq('id', requestId);
      
      Audit.depositCompleted(reqData.telegram_id, req.ip, { 
        transactionId: requestId.toString(), 
        providerRef: reqData.id.toString(),
        amount: reqData.amount, 
        currency: 'ETB', 
        method: reqData.payment_type || 'unknown',
        adminId: admin.id,
        adminName: admin.name
      });
      
      if (!user.first_deposit_amount || user.first_deposit_amount === 0) {
        user.first_deposit_amount = reqData.amount;
        await supabase.from('users').update({ 
          first_deposit_amount: user.first_deposit_amount 
        }).eq('telegram_id', reqData.telegram_id);
        console.log(`💰 First deposit recorded for ${reqData.telegram_id}: ${reqData.amount}`);
      }
      
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) { 
        playerSocket.emit('balanceUpdate', user.balance); 
        playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount }); 
      }
      
      res.json({ success: true, newBalance: user.balance });
    } else {
      await supabase.from('deposit_requests').update({ 
        status: 'rejected', 
        processed_at: new Date().toISOString() 
      }).eq('id', requestId);
      
      Audit.depositFailed(reqData.telegram_id, req.ip, { 
        transactionId: requestId.toString(), 
        amount: reqData.amount, 
        reason: 'rejected_by_admin',
        adminId: admin.id,
        adminName: admin.name
      });
      
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
      
      res.json({ success: true });
    }
  } catch (err) {
    console.error('Process deposit error:', err.message);
    res.status(500).json({ error: err.message });
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
  
  try {
    const user = await loadUser(userId, null, null, null, false);
    if (!user || user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
    
    // Check if user has an admin assigned
    let adminId = user.admin_id;
    let adminName = user.assigned_admin_name;
    
    // If no admin assigned, try to find one (shouldn't happen, but just in case)
    if (!adminId) {
      const admins = await getAllAdmins();
      if (admins.length > 0) {
        adminId = admins[0].id;
        adminName = admins[0].name;
      }
    }
    
    const { data, error } = await supabase.from('withdrawal_requests').insert({
      telegram_id: userId,
      username: user.username,
      amount: amt,
      status: 'pending',
      phone_number: receiver,
      withdrawal_type,
      receiver_name: receiverName,
      admin_id: adminId,
      assigned_admin_name: adminName
    }).select().single();
    
    if (error) throw error;
    
    Audit.withdrawalRequested(userId, req.ip, { 
      transactionId: data.id.toString(), 
      amount: amt, 
      currency: 'ETB', 
      method: withdrawal_type, 
      receiver,
      name: receiverName,
      adminId: adminId,
      adminName: adminName
    });
    
    res.json({ 
      success: true, 
      requestId: data.id, 
      message: `Withdrawal request of ${amt} ETB via ${withdrawal_type} to ${receiver} submitted.` 
    });
  } catch (err) {
    console.error('Withdrawal request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/withdrawals', async (req, res) => {
  const { secret } = req.query;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('status', 'pending')
      .eq('admin_id', admin.id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.json({ requests: data, admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    const { data: reqData, error: fetchErr } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', requestId)
      .eq('admin_id', admin.id)
      .single();
    
    if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found or not assigned to you' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    
    if (action === 'approve') {
      const user = await loadUser(reqData.telegram_id, null, null, null, false);
      if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
      
      user.balance -= reqData.amount;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
      await supabase.from('withdrawal_requests').update({ 
        status: 'approved', 
        processed_at: new Date().toISOString() 
      }).eq('id', requestId);
      
      Audit.withdrawalCompleted(reqData.telegram_id, req.ip, { 
        transactionId: requestId.toString(), 
        amount: reqData.amount, 
        currency: 'ETB', 
        method: reqData.withdrawal_type || 'N/A',
        receiver: reqData.phone_number,
        adminId: admin.id,
        adminName: admin.name
      });
      
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) { 
        playerSocket.emit('balanceUpdate', user.balance); 
        playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number }); 
      }
      
      res.json({ success: true, newBalance: user.balance });
    } else {
      await supabase.from('withdrawal_requests').update({ 
        status: 'rejected', 
        processed_at: new Date().toISOString() 
      }).eq('id', requestId);
      
      Audit.withdrawalRejected(reqData.telegram_id, req.ip, { 
        transactionId: requestId.toString(), 
        amount: reqData.amount, 
        reason: 'rejected_by_admin',
        adminId: admin.id,
        adminName: admin.name
      });
      
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
      
      res.json({ success: true });
    }
  } catch (err) {
    console.error('Process withdrawal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin endpoints for player management ----------
app.get('/admin/players', async (req, res) => {
  const { secret } = req.query;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    const players = await getAdminPlayers(admin.id);
    
    const playersWithStats = await Promise.all(players.map(async (player) => {
      const { data: deposits } = await supabase
        .from('deposit_requests')
        .select('amount, status, created_at')
        .eq('telegram_id', player.telegram_id)
        .eq('admin_id', admin.id)
        .order('created_at', { ascending: false })
        .limit(5);
      
      return {
        ...player,
        recentDeposits: deposits || []
      };
    }));
    
    res.json({ 
      success: true,
      admin: {
        id: admin.id,
        name: admin.name,
        phone: admin.phone
      },
      players: playersWithStats,
      count: playersWithStats.length
    });
  } catch (err) {
    console.error('Error fetching admin players:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/stats', async (req, res) => {
  const { secret } = req.query;
  if (!secret) return res.status(403).json({ error: 'Admin secret required' });
  
  try {
    const admin = await loadAdmin(secret);
    if (!admin) return res.status(403).json({ error: 'Invalid admin credentials' });
    
    const playerCount = await getAdminPlayerCount(admin.id);
    
    const { data: deposits } = await supabase
      .from('deposit_requests')
      .select('amount, status, created_at')
      .eq('admin_id', admin.id);
    
    const totalDeposits = deposits
      .filter(d => d.status === 'approved')
      .reduce((sum, d) => sum + Number(d.amount), 0);
    
    const today = new Date();
    today.setHours(0,0,0,0);
    const todayDeposits = deposits
      .filter(d => d.status === 'approved' && new Date(d.created_at) >= today)
      .reduce((sum, d) => sum + Number(d.amount), 0);
    
    const { data: withdrawals } = await supabase
      .from('withdrawal_requests')
      .select('amount, status')
      .eq('admin_id', admin.id);
    
    const totalWithdrawals = withdrawals
      .filter(w => w.status === 'approved')
      .reduce((sum, w) => sum + Number(w.amount), 0);
    
    const pendingWithdrawals = withdrawals
      .filter(w => w.status === 'pending')
      .length;
    
    res.json({
      success: true,
      admin: {
        id: admin.id,
        name: admin.name,
        phone: admin.phone,
        deposit_number: admin.deposit_number
      },
      stats: {
        playerCount,
        totalDeposits,
        todayDeposits,
        totalWithdrawals,
        pendingWithdrawals,
        pendingDeposits: deposits.filter(d => d.status === 'pending').length
      }
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Statistics endpoints ----------
app.get('/stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'stats.html'));
});

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

// ---------- REFERRAL ENDPOINTS ----------
app.get('/api/invite-stats', async (req, res) => {
  const { secret } = req.query;
  if (secret && secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { data, error } = await supabase
      .from('invite_stats')
      .select('*')
      .order('invite_code', { ascending: true });
    if (error) throw error;
    const stats = {};
    data.forEach(row => { stats[row.invite_code] = row.count; });
    res.json(stats);
  } catch (err) {
    console.error('Error fetching invite stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/invite-details', async (req, res) => {
  const { secret } = req.query;
  if (secret && secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { data: referredUsers, error } = await supabase
      .from('users')
      .select('username, referred_by, first_deposit_amount')
      .not('referred_by', 'is', null)
      .gt('first_deposit_amount', 0);
    if (error) throw error;
    const grouped = {};
    for (const user of referredUsers) {
      const code = user.referred_by;
      if (!grouped[code]) grouped[code] = { players: [], totalBonus: 0, totalDeposits: 0 };
      const bonus = user.first_deposit_amount * 0.1;
      grouped[code].players.push({
        username: user.username || 'Anonymous',
        deposit: user.first_deposit_amount,
        bonus: bonus
      });
      grouped[code].totalBonus += bonus;
      grouped[code].totalDeposits += user.first_deposit_amount;
    }
    const { data: allCodes } = await supabase.from('invite_stats').select('invite_code');
    const allCodeSet = new Set(allCodes.map(c => c.invite_code));
    for (const code of allCodeSet) {
      if (!grouped[code]) grouped[code] = { players: [], totalBonus: 0, totalDeposits: 0 };
    }
    res.json({ success: true, data: grouped });
  } catch (error) {
    console.error('Error fetching invite details:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- Audit endpoints ----------
app.get('/admin/audit', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  const { roomId, userId, eventType, from, to, limit = 200 } = req.query;
  try {
    let query = supabase.from('audit_logs').select('*', { count: 'exact' });
    if (roomId) query = query.eq('room_id', roomId);
    if (userId) query = query.eq('user_id', userId);
    if (eventType) query = query.eq('event_type', eventType);
    if (from) query = query.gte('timestamp', from);
    if (to) query = query.lte('timestamp', to);
    query = query.order('timestamp', { ascending: false }).limit(Math.min(parseInt(limit), 1000));
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ success: true, logs: data, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
    broadcastPlayerCount(currentStake);
    socket.emit('yourCard', player.card);
    notifyAdminClients();
    if (currentStake === 20) checkAndAddThirdBot(currentStake);
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
    broadcastPlayerCount(currentStake);
    socket.emit('yourCard', player.card);
    notifyAdminClients();
    if (currentStake === 20) checkAndAddThirdBot(currentStake);
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
    handleBingoClaim(socket.userId, currentStake);
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
        .select('telegram_id, username, balance, telegram_handle, referred_by, first_deposit_amount, admin_id, assigned_admin_name');
      if (error) throw error;
      const usersList = (allUsers || []).map(u => ({
        telegramId: u.telegram_id,
        username: u.username,
        balance: u.balance,
        telegram_handle: u.telegram_handle,
        referred_by: u.referred_by,
        first_deposit_amount: u.first_deposit_amount || 0,
        admin_id: u.admin_id,
        assigned_admin_name: u.assigned_admin_name
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
