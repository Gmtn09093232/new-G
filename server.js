// ================================================================
//  server.js – Full Bingo Server (corrected)
//             - No secret backdoor
//             - Real-time admin events
//             - Session-auth admin sockets
//             - Winner history broadcasting
//             - Cascade player delete
//             - Deposit proof photos in admin finance view
//             - 50 Birr Stake Added
//             - Invalid Bingo Socket Emit Added
//             - 2 bots only, no force win
//             - WIN CONDITION: 2 completed lines required (was 1)
// ================================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// ---------- Fail-fast on required secrets ----------
const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET || ADMIN_SECRET.length < 6) {
  console.error('❌ FATAL: ADMIN_SECRET env var is required (min 6 chars).');
  console.error('   Refusing to start with a default/weak secret.');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!process.env.BOT_TOKEN) {
  console.error('❌ FATAL: BOT_TOKEN is required.');
  process.exit(1);
}

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

// ---------- Ensure deposit-photos bucket ----------
async function ensureDepositBucket() {
  const bucketName = 'deposit-photos';
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) { console.error('❌ Failed to list buckets:', listError.message); return; }
    const exists = buckets.some(b => b.name === bucketName);
    if (!exists) {
      console.log(`📦 Creating storage bucket "${bucketName}"...`);
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true, file_size_limit: 5242880,
        allowed_mime_types: ['image/png','image/jpeg','image/jpg','image/gif','image/webp']
      });
      if (createError) console.error('❌ Failed to create bucket:', createError.message);
      else console.log(`✅ Bucket "${bucketName}" created.`);
    } else console.log(`✅ Bucket "${bucketName}" already exists.`);
  } catch (err) { console.error('❌ Error ensuring bucket:', err.message); }
}
ensureDepositBucket();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'), false);
  }
});

app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
});
app.use(sessionMiddleware);

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ---------- Audit Logger ----------
async function logAuditEvent({ eventType, roomId = null, userId = 'system', ipAddress = null, details = {} }) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({ event_type: eventType, room_id: roomId, user_id: userId, ip_address: ipAddress, details });
    if (error) throw error;
  } catch (err) { console.error(`[AUDIT FAIL] ${eventType} (user ${userId}):`, err.message); }
}

const Audit = {
  depositInitiated: (u, ip, d) => logAuditEvent({ eventType: 'DEPOSIT_INITIATED', userId: u, ipAddress: ip, details: d }),
  depositCompleted: (u, ip, d) => logAuditEvent({ eventType: 'DEPOSIT_COMPLETED', userId: u, ipAddress: ip, details: d }),
  depositFailed: (u, ip, d) => logAuditEvent({ eventType: 'DEPOSIT_FAILED', userId: u, ipAddress: ip, details: d }),
  withdrawalRequested: (u, ip, d) => logAuditEvent({ eventType: 'WITHDRAWAL_REQUESTED', userId: u, ipAddress: ip, details: d }),
  withdrawalCompleted: (u, ip, d) => logAuditEvent({ eventType: 'WITHDRAWAL_COMPLETED', userId: u, ipAddress: ip, details: d }),
  withdrawalRejected: (u, ip, d) => logAuditEvent({ eventType: 'WITHDRAWAL_REJECTED', userId: u, ipAddress: ip, details: d }),
  bingoCalled: (roomId, u, ip, d) => logAuditEvent({ eventType: 'BINGO_CALLED', roomId, userId: u, ipAddress: ip, details: d }),
  bingoRejected: (roomId, u, ip, d) => logAuditEvent({ eventType: 'BINGO_REJECTED', roomId, userId: u, ipAddress: ip, details: d }),
  winPaidOut: (roomId, u, ip, d) => logAuditEvent({ eventType: 'WIN_PAID_OUT', roomId, userId: u, ipAddress: ip, details: d }),
  numberDrawn: (roomId, d) => logAuditEvent({ eventType: 'NUMBER_DRAWN', roomId, details: d }),
  cardAssigned: (roomId, u, ip, d) => logAuditEvent({ eventType: 'CARD_ASSIGNED', roomId, userId: u, ipAddress: ip, details: d }),
  adminAction: (eventType, adminId, ip, d) => logAuditEvent({ eventType, userId: adminId, ipAddress: ip, details: d }),
  suspicious: (roomId, u, ip, d) => logAuditEvent({ eventType: 'SUSPICIOUS_BEHAVIOR_DETECTED', roomId, userId: u, ipAddress: ip, details: d })
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

// ---------- Admin Helpers ----------
const adminCache = {};
async function loadAdmin(secretKey) {
  if (adminCache[secretKey] && (Date.now() - adminCache[secretKey].cachedAt < 60000)) return adminCache[secretKey];
  try {
    const { data, error } = await supabase.from('admins').select('*')
      .eq('secret_key', secretKey).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (data) { adminCache[secretKey] = { ...data, cachedAt: Date.now() }; return adminCache[secretKey]; }
    return null;
  } catch (err) { console.error('Error loading admin:', err.message); return null; }
}
async function getAllAdmins() {
  try {
    const { data, error } = await supabase.from('admins').select('*').eq('is_active', true).order('name');
    if (error) throw error;
    return data || [];
  } catch (err) { console.error('Error fetching admins:', err.message); return []; }
}
async function getAdminPlayers(adminId) {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('admin_id', adminId).order('username');
    if (error) throw error;
    return data || [];
  } catch (err) { console.error('Error fetching admin players:', err.message); return []; }
}
async function getAdminPlayerCount(adminId) {
  try {
    const { count, error } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('admin_id', adminId);
    if (error) throw error;
    return count || 0;
  } catch (err) { console.error('Error counting admin players:', err.message); return 0; }
}
async function getAdminDeposits(adminId, status = 'approved') {
  try {
    const { data, error } = await supabase.from('deposit_requests').select('amount').eq('admin_id', adminId).eq('status', status);
    if (error) throw error;
    return data.reduce((sum, d) => sum + Number(d.amount), 0);
  } catch (err) { console.error('Error fetching admin deposits:', err.message); return 0; }
}
async function getAdminHoldingBalance(adminId) {
  const { data: deposits, error: depErr } = await supabase.from('deposit_requests').select('amount').eq('admin_id', adminId).eq('status', 'approved');
  if (depErr) throw depErr;
  const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);
  const { data: adjustments, error: adjErr } = await supabase.from('admin_deposit_adjustments').select('amount').eq('admin_id', adminId);
  if (adjErr) throw adjErr;
  const totalAdjustments = adjustments.reduce((sum, a) => sum + Number(a.amount), 0);
  return totalDeposits + totalAdjustments;
}
async function getAdminEarnings(adminId) {
  const { data: contributions, error: contribErr } = await supabase.from('game_admin_contributions')
    .select('house_profit_share, created_at').eq('admin_id', adminId);
  if (contribErr) { console.error('Error fetching contributions:', contribErr.message); return { pending: 0, earned: 0 }; }

  const { data: paidCommissions, error: paidErr } = await supabase.from('admin_daily_commissions')
    .select('commission_amount, date').eq('admin_id', adminId).eq('status', 'paid');
  if (paidErr) { console.error('Error fetching paid commissions:', paidErr.message); return { pending: 0, earned: 0 }; }

  const paidDates = new Set((paidCommissions || []).map(c => c.date));
  let pending = 0;
  if (contributions) {
    for (const contrib of contributions) {
      const dateStr = new Date(contrib.created_at).toISOString().split('T')[0];
      if (!paidDates.has(dateStr)) pending += Number(contrib.house_profit_share) || 0;
    }
  }
  const earned = paidCommissions ? paidCommissions.reduce((s, c) => s + Number(c.commission_amount), 0) : 0;
  return { pending, earned };
}
async function markContributionsAsPaid(adminId, amount, paidAt = new Date().toISOString()) {
  const { data: paidCommissions, error: paidErr } = await supabase.from('admin_daily_commissions')
    .select('date').eq('admin_id', adminId).eq('status', 'paid');
  if (paidErr) throw paidErr;
  const paidDates = new Set(paidCommissions.map(d => d.date));

  const { data: contributions, error: contribErr } = await supabase.from('game_admin_contributions')
    .select('created_at, house_profit_share').eq('admin_id', adminId).order('created_at', { ascending: true });
  if (contribErr) throw contribErr;

  const grouped = {};
  for (const c of contributions) {
    const date = new Date(c.created_at).toISOString().split('T')[0];
    if (!paidDates.has(date)) { if (!grouped[date]) grouped[date] = 0; grouped[date] += Number(c.house_profit_share) || 0; }
  }

  let remaining = amount;
  const sortedDates = Object.keys(grouped).sort();
  for (const date of sortedDates) {
    if (remaining <= 0) break;
    const available = grouped[date];
    const toPay = Math.min(available, remaining);

    const { data: existing, error: existErr } = await supabase
      .from('admin_daily_commissions').select('id, commission_amount')
      .eq('admin_id', adminId).eq('date', date).maybeSingle();
    if (existErr) throw existErr;

    if (existing) {
      const { error: updateErr } = await supabase
        .from('admin_daily_commissions')
        .update({ status: 'paid', paid_at: paidAt })
        .eq('id', existing.id);
      if (updateErr) throw updateErr;
    } else {
      const { error: insertErr } = await supabase.from('admin_daily_commissions').insert({
        admin_id: adminId, date, total_entry_fees: 0,
        total_house_profit: grouped[date], commission_amount: grouped[date],
        status: 'paid', paid_at: paidAt
      });
      if (insertErr) throw insertErr;
    }
    remaining -= toPay;
  }
  if (remaining > 0) throw new Error(`Insufficient pending earnings: only ${amount - remaining} of ${amount} was covered`);
  return true;
}
async function isSuperAdmin(adminId) {
  try {
    const { data, error } = await supabase.from('admins').select('is_super_admin')
      .eq('id', adminId).eq('is_active', true).maybeSingle();
    if (error || !data) return false;
    return data.is_super_admin === true;
  } catch { return false; }
}
async function getAdminFromSession(req) {
  if (!req.session.adminId) return null;
  const { data, error } = await supabase.from('admins').select('*')
    .eq('id', req.session.adminId).eq('is_active', true).maybeSingle();
  if (error || !data) { req.session.destroy(); return null; }
  return data;
}

// ---------- Transaction Number Extractor ----------
function extractTransactionNumber(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+\/receipt\/([A-Za-z0-9]+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const patterns = [
    /transaction\s+number\s+is\s+([A-Za-z0-9]+)/i,
    /transaction\s+number\s*[:]\s*([A-Za-z0-9]+)/i,
    /TID\s*[:=]\s*([A-Za-z0-9]+)/i,
    /reference\s*[:=]\s*([A-Za-z0-9]+)/i,
    /receipt\/([A-Za-z0-9]+)/i,
    /\b([A-Za-z0-9]{8,16})\b/
  ];
  for (const pattern of patterns) { const m = trimmed.match(pattern); if (m) return m[1].toUpperCase(); }
  if (/^[A-Za-z0-9]{8,16}$/.test(trimmed)) return trimmed.toUpperCase();
  const fallback = trimmed.match(/\b([A-Za-z0-9]{8,16})\b/);
  return fallback ? fallback[1].toUpperCase() : null;
}

// ---------- Static endpoints ----------
app.get('/api/deposit-accounts', async (req, res) => {
  try {
    const userId = req.session?.userId;
    let adminId = null;
    if (userId) {
      const { data: user, error } = await supabase.from('users').select('admin_id').eq('telegram_id', userId).maybeSingle();
      if (!error && user) adminId = user.admin_id;
    }
    let admins = [];
    if (adminId) {
      const { data: admin, error } = await supabase.from('admins')
        .select('id, name, telebirr_number, cbebirr_number, mpesa_number, accept_deposits')
        .eq('id', adminId).eq('is_active', true).maybeSingle();
      if (error) throw error;
      if (admin && admin.accept_deposits !== false) admins = [admin];
    } else {
      const { data: allAdmins, error: allErr } = await supabase.from('admins')
        .select('id, name, telebirr_number, cbebirr_number, mpesa_number, accept_deposits').eq('is_active', true);
      if (allErr) throw allErr;
      admins = allAdmins.filter(a => a.accept_deposits !== false);
    }
    res.json({
      success: true,
      admins: admins.map(a => ({
        id: a.id, name: a.name,
        telebirr: a.telebirr_number || null,
        cbebirr: a.cbebirr_number || null,
        mpesa: a.mpesa_number || null
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin-phone', (req, res) => res.json({ phone: process.env.ADMIN_PHONE || '' }));

// Static HTML
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit',   (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/live',    (req, res) => res.sendFile(path.join(__dirname, 'live.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/users',   (req, res) => res.sendFile(path.join(__dirname, 'users.html')));
app.get('/invite-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-dashboard.html')));
app.get('/bots',    (req, res) => res.sendFile(path.join(__dirname, 'bots.html')));
app.get('/admin-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));
app.get('/admin-auth', (req, res) => res.sendFile(path.join(__dirname, 'admin-auth.html')));
app.get('/super-admin', (req, res) => res.sendFile(path.join(__dirname, 'super-admin.html')));
app.get('/welcome', (req, res) => res.sendFile(path.join(__dirname, 'welcome.html')));
app.get('/invite-tracking-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-tracking-dashboard.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

// ---------- User cache ----------
const users = {};

// ============================================================
//  loadUser – FORCE INVITE ONLY
// ============================================================
async function loadUser(telegramId, username, telegramHandle = null, inviteCode = null, refresh = false, adminId = null) {
  const id = String(telegramId);
  if (!refresh && users[id]) return users[id];
  try {
    let { data, error } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
    if (error) throw error;

    if (data) {
      let needUpdate = false;
      if (!data.invite_code || !data.admin_id) {
        const { data: inviteTrack, error: trackErr } = await supabase.from('invite_tracking')
          .select('invite_code, admin_id, admin_name').eq('telegram_id', id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!trackErr && inviteTrack) {
          if (!data.invite_code && inviteTrack.invite_code) { data.invite_code = inviteTrack.invite_code; needUpdate = true; }
          if (!data.admin_id && inviteTrack.admin_id) {
            data.admin_id = inviteTrack.admin_id;
            data.admin_name = inviteTrack.admin_name || null;
            needUpdate = true;
          }
        }
      }
      if (inviteCode && !data.invite_code) { data.invite_code = inviteCode; needUpdate = true; }
      if (!data.admin_id && data.invite_code) {
        const { data: admin, error: adminErr } = await supabase.from('admins')
          .select('id, name').eq('invite_code', data.invite_code).eq('is_active', true).maybeSingle();
        if (!adminErr && admin) { data.admin_id = admin.id; data.admin_name = admin.name; needUpdate = true; }
      }
      if (needUpdate) {
        const { error: updateErr } = await supabase.from('users')
          .update({ invite_code: data.invite_code, admin_id: data.admin_id, admin_name: data.admin_name })
          .eq('telegram_id', id);
        if (updateErr) console.error('Failed to update user:', updateErr.message);
      }

      users[id] = {
        id, username: data.username, balance: Number(data.balance),
        telegram_handle: data.telegram_handle, invite_code: data.invite_code,
        first_deposit_amount: data.first_deposit_amount || 0,
        admin_id: data.admin_id, admin_name: data.admin_name
      };
      return users[id];
    } else {
      let finalInviteCode = inviteCode || null;
      let finalAdminId = adminId || null;
      let finalAdminName = null;

      if (!finalInviteCode || !finalAdminId) {
        const { data: inviteTrack, error: trackErr } = await supabase.from('invite_tracking')
          .select('invite_code, admin_id, admin_name').eq('telegram_id', id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!trackErr && inviteTrack) {
          if (!finalInviteCode) finalInviteCode = inviteTrack.invite_code;
          if (!finalAdminId) { finalAdminId = inviteTrack.admin_id; finalAdminName = inviteTrack.admin_name; }
        }
      }
      if (!finalAdminId && finalInviteCode) {
        const { data: admin, error: adminErr } = await supabase.from('admins')
          .select('id, name').eq('invite_code', finalInviteCode).eq('is_active', true).maybeSingle();
        if (!adminErr && admin) { finalAdminId = admin.id; finalAdminName = admin.name; }
      }
      if (!finalInviteCode) {
        console.log(`❌ Blocked user creation for ${id} – no invite code provided.`);
        throw new Error('Invite required. Please use an invite link from an admin to create an account.');
      }

      const newUser = {
        telegram_id: id, username: username || 'Player',
        telegram_handle: telegramHandle || null, balance: 10,
        invite_code: finalInviteCode, first_deposit_amount: 0,
        admin_id: finalAdminId, admin_name: finalAdminName
      };
      const { error: insertError } = await supabase.from('users').insert(newUser);
      if (insertError) throw insertError;

      if (finalInviteCode && finalAdminId) {
        const { data: existingTrack } = await supabase.from('invite_tracking').select('id')
          .eq('telegram_id', id).eq('invite_code', finalInviteCode).maybeSingle();
        if (!existingTrack) {
          await supabase.from('invite_tracking').insert({
            telegram_id: id, username: username || 'Player',
            invite_code: finalInviteCode, admin_id: finalAdminId,
            admin_name: finalAdminName, ip_address: null, user_agent: null
          });
        }
      }

      users[id] = {
        id, username: newUser.username, balance: 10,
        telegram_handle: newUser.telegram_handle, invite_code: newUser.invite_code,
        first_deposit_amount: 0, admin_id: newUser.admin_id, admin_name: newUser.admin_name
      };
      return users[id];
    }
  } catch (err) {
    console.error(`❌ loadUser error for ${id}:`, err.message);
    throw err;
  }
}

// ---------- Telegram verification (timing-safe) ----------
function verifyTelegram(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(calculatedHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) { console.error('❌ Verification error:', err.message); return false; }
}

// ---------- Telegram auth ----------
app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) return res.status(403).json({ success: false, error: 'Invalid initData' });
  try {
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get('user'));
    const startParam = params.get('start_param');
    const id = String(userData.id);
    const displayName = userData.first_name || userData.username || 'Player';
    const handle = userData.username || null;

    const user = await loadUser(id, displayName, handle, startParam, !!startParam);
    req.session.userId = id;
    req.session.save(err => {
      if (err) return res.status(500).json({ success: false, error: 'Session save failed' });
      res.json({
        success: true, userId: id, username: user.username, balance: user.balance,
        telegram_handle: user.telegram_handle, admin_id: user.admin_id,
        admin_name: user.admin_name, invite_code: user.invite_code
      });
    });
  } catch (err) {
    if (err.message.includes('Invite required')) {
      return res.status(403).json({ success: false, error: 'Invite required. Please use an invite link from an admin.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Admin Login ----------
app.post('/admin/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ success: false, error: 'Phone and PIN required' });
  try {
    const { data: admin, error } = await supabase.from('admins').select('*')
      .eq('phone', phone).eq('pin', pin).eq('is_active', true).maybeSingle();
    if (error || !admin) return res.status(401).json({ success: false, error: 'Invalid phone or PIN' });
    req.session.adminId = admin.id;
    req.session.adminName = admin.name;
    req.session.adminPhone = admin.phone;
    req.session.adminSecret = admin.secret_key;
    res.json({ success: true, admin: { id: admin.id, name: admin.name, phone: admin.phone, deposit_number: admin.deposit_number } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/register', async (req, res) => {
  const { phone, name, deposit_number, payment_type, pin, confirm_pin,
          registration_secret, telebirr_number, cbebirr_number, mpesa_number } = req.body;
  if (!phone || !name || !pin || !confirm_pin) return res.status(400).json({ success: false, error: 'Phone, name, and PIN are required' });
  if (pin !== confirm_pin) return res.status(400).json({ success: false, error: 'PINs do not match' });
  if (pin.length < 4 || !/^\d+$/.test(pin)) return res.status(400).json({ success: false, error: 'PIN must be at least 4 digits' });
  if (!phone.match(/^(09|07)\d{8}$/)) return res.status(400).json({ success: false, error: 'Invalid phone number' });
  if (payment_type && !['telebirr', 'cbebirr', 'mpesa'].includes(payment_type))
    return res.status(400).json({ success: false, error: 'Invalid payment type' });

  const requiredSecret = process.env.ADMIN_REGISTRATION_SECRET;
  if (requiredSecret && registration_secret !== requiredSecret)
    return res.status(403).json({ success: false, error: 'Invalid registration secret' });

  try {
    const { data: existing } = await supabase.from('admins').select('phone').eq('phone', phone).maybeSingle();
    if (existing) return res.status(400).json({ success: false, error: 'Phone number already registered' });

    const secretKey = crypto.randomBytes(16).toString('hex');
    const inviteCode = name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const { data: newAdmin, error: insertErr } = await supabase.from('admins').insert({
      phone, name, deposit_number: deposit_number || null,
      payment_type: payment_type || null, secret_key: secretKey, pin,
      invite_code: inviteCode, commission_rate: 0.40, is_active: true,
      telebirr_number: telebirr_number || null,
      cbebirr_number: cbebirr_number || null,
      mpesa_number: mpesa_number || null,
      accept_deposits: true
    }).select().single();
    if (insertErr) throw insertErr;
    res.json({ success: true, message: 'Registration successful!', admin: { id: newAdmin.id, name: newAdmin.name, phone: newAdmin.phone, deposit_number: newAdmin.deposit_number } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/admin/session', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ success: false, error: 'Session expired or deactivated' }); }
  res.json({
    success: true,
    admin: {
      id: admin.id, name: admin.name, phone: admin.phone,
      deposit_number: admin.deposit_number, commission_rate: admin.commission_rate,
      invite_code: admin.invite_code,
      telebirr_number: admin.telebirr_number,
      cbebirr_number: admin.cbebirr_number,
      mpesa_number: admin.mpesa_number
    }
  });
});

app.get('/admin/registration-config', (req, res) => res.json({ requiresSecret: !!process.env.ADMIN_REGISTRATION_SECRET }));

app.get('/admin/invite-info', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'bingomkmk0120_bot';
    const inviteLink = `https://t.me/${botUsername}?start=${admin.invite_code}`;
    res.json({
      success: true,
      admin: {
        id: admin.id, name: admin.name, invite_code: admin.invite_code,
        invite_link: inviteLink, phone: admin.phone, deposit_number: admin.deposit_number
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- User invite code ----------
app.get('/api/user/invite-code', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ success: false, error: 'Not logged in' });
  try {
    const { data: user, error } = await supabase.from('users')
      .select('invite_code, admin_id, admin_name').eq('telegram_id', String(userId)).maybeSingle();
    if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });

    const { data: inviteTrack } = await supabase.from('invite_tracking').select('*')
      .eq('telegram_id', String(userId)).order('created_at', { ascending: false }).limit(1).maybeSingle();

    let adminInfo = null;
    if (user.admin_id) {
      const { data: admin } = await supabase.from('admins').select('name, invite_code').eq('id', user.admin_id).maybeSingle();
      if (admin) adminInfo = admin;
    }
    res.json({
      success: true, invite_code: user.invite_code,
      admin_id: user.admin_id, admin_name: user.admin_name,
      admin: adminInfo, invite_tracking: inviteTrack || null
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------- Legacy admin balance management ----------
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const user = await loadUser(strId, 'unknown', null, null, true);
    user.balance += amt;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);
    await supabase.from('deposit_requests').insert({
      telegram_id: strId, username: user.username, amount: amt,
      status: 'approved', phone: 'manual', payment_type: 'manual',
      proof_photo_url: null, processed_at: new Date().toISOString()
    });
    Audit.adminAction('ADMIN_ADD_BALANCE', 'admin', req.ip, { targetUserId: strId, amount: amt, newBalance: user.balance });
    const playerSocket = await getSocketByUserId(strId);
    if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
    res.json({ success: true, newBalance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ✅ /admin/set-balance
// ============================================================
app.post('/admin/set-balance', async (req, res) => {
  const { secret, userId, telegramId, newBalance } = req.body;

  let authorizedAdmin = null;
  if (secret === ADMIN_SECRET) {
    authorizedAdmin = null;
  } else {
    const admin = await getAdminFromSession(req);
    if (!admin) return res.status(403).json({ error: 'Forbidden — invalid secret or no session' });
    authorizedAdmin = admin;
  }

  const strId = String(userId || telegramId || '');
  const newBal = Number(newBalance);
  if (!strId || strId === 'undefined') return res.status(400).json({ error: 'userId required' });
  if (isNaN(newBal) || newBal < 0) return res.status(400).json({ error: 'Balance must be non-negative' });

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('users').select('*').eq('telegram_id', strId).maybeSingle();
    if (fetchErr || !existing) return res.status(404).json({ error: 'User not found' });

    if (authorizedAdmin && existing.admin_id !== authorizedAdmin.id) {
      return res.status(403).json({ error: 'This player is not assigned to you' });
    }

    const oldBalance = Number(existing.balance) || 0;
    const delta = newBal - oldBalance;

    await supabase.from('users').update({ balance: newBal }).eq('telegram_id', strId);
    if (users[strId]) users[strId].balance = newBal;
    else await loadUser(strId, existing.username, existing.telegram_handle, null, true);

    if (delta > 0) {
      try {
        const { error: depErr } = await supabase.from('deposit_requests').insert({
          telegram_id: strId,
          username: existing.username || 'Player',
          amount: delta,
          status: 'approved',
          phone: 'manual',
          payment_type: 'manual',
          transaction_reference: null,
          proof_photo_url: null,
          assigned_deposit_number: null,
          admin_id: existing.admin_id || (authorizedAdmin ? authorizedAdmin.id : null),
          processed_at: new Date().toISOString()
        });
        if (depErr) console.error('❌ Failed to record manual deposit_requests row:', depErr.message);
      } catch (e) {
        console.error('❌ Manual deposit insert threw:', e.message);
      }
    } else if (delta < 0) {
      try {
        const { error: wdErr } = await supabase.from('withdrawal_requests').insert({
          telegram_id: strId,
          username: existing.username || 'Player',
          amount: Math.abs(delta),
          status: 'approved',
          phone_number: 'manual',
          withdrawal_type: 'manual',
          receiver_name: 'manual adjustment',
          admin_id: existing.admin_id || (authorizedAdmin ? authorizedAdmin.id : null),
          admin_name: existing.admin_name || (authorizedAdmin ? authorizedAdmin.name : 'super'),
          processed_at: new Date().toISOString()
        });
        if (wdErr) console.error('❌ Failed to record manual withdrawal_requests row:', wdErr.message);
      } catch (e) {
        console.error('❌ Manual withdrawal insert threw:', e.message);
      }
    }

    Audit.adminAction(
      'ADMIN_SET_BALANCE',
      authorizedAdmin ? authorizedAdmin.id : 'super',
      req.ip,
      { targetUserId: strId, oldBalance, newBalance: newBal, delta }
    );

    const playerSocket = await getSocketByUserId(strId);
    if (playerSocket) playerSocket.emit('balanceUpdate', newBal);

    if (authorizedAdmin) {
      emitToAdminId(authorizedAdmin.id, 'player:balance', { telegram_id: strId, balance: newBal });
    }

    res.json({ success: true, newBalance: newBal, delta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/delete-user', async (req, res) => {
  const { secret, telegramId } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  try {
    const { data: user, error: findErr } = await supabase.from('users').select('telegram_id').eq('telegram_id', strId).maybeSingle();
    if (findErr || !user) return res.status(404).json({ error: 'User not found' });
    await supabase.from('users').delete().eq('telegram_id', strId);
    for (const stake of [10, 20, 30, 50]) {
      const game = games[stake];
      if (!game) continue;
      const idx = game.players.findIndex(p => p.telegramId === strId);
      if (idx !== -1) {
        const player = game.players[idx];
        if (player.cardNumber) game.takenCardNumbers.delete(player.cardNumber);
        game.players.splice(idx, 1);
        io.to(`stake_${stake}`).emit('cardTaken', { stake, number: player.cardNumber, takenNumbers: Array.from(game.takenCardNumbers) });
        broadcastPlayerCount(stake);
        if (game.status === 'running' && game.players.length === 0) { clearInterval(game.callInterval); endGameWithWinners(stake); }
      }
    }
    delete users[strId];
    Audit.adminAction('ADMIN_DELETE_USER', 'admin', req.ip, { targetUserId: strId });
    res.json({ success: true, message: `User ${strId} deleted` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Bingo Game Logic ----------
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
      if (col === 2 && row === 2) colNumbers.push('FREE');
      else colNumbers.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]);
    }
    card.push(colNumbers);
  }
  const transposed = [];
  for (let r = 0; r < 5; r++) transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  return transposed;
}

function createGameState(entryFee) {
  return {
    status: 'lobby', players: [], takenCardNumbers: new Set(),
    calledNumbers: [], entryFee, prizePool: 0,
    lobbyTimer: null, callInterval: null, lobbyEndTime: 0,
    cardSet: Array.from({ length: 100 }, () => generateCard()),
    winners: [], bingoGraceTimeout: null, winningNumber: null,
    botTimeouts: []
  };
}

const games = { 10: createGameState(10), 20: createGameState(20), 30: createGameState(30), 50: createGameState(50) };

const BOT_IDS = ['1945854','8696548'];
const botBalances = new Map();
BOT_IDS.forEach(id => botBalances.set(id, 1000));

const ETHIOPIAN_MALE_NAMES = [
  'Abe','Alex','mekia','Dawit','Fikru','Girma','Haile','zid','sura cr7','nega',
  'Mekonnen','Nebiyu','baye','Robel','teddy','Tadesse','Wondia','Yared','Zemenu','Birukee',
  'bura','Ermias','Fitsum','shaki','belaya','Mulugeta','Nati','dera','Tekle','Worku',
  'jhone','Aman','Belete','Daniel','Endalk','Gashaw','Habtia','kassish','Lul','Mengistu',
  'Mulu','abela','Tesfaye','Wolde'
];
function getRandomMaleEthiopianName() { return ETHIOPIAN_MALE_NAMES[Math.floor(Math.random() * ETHIOPIAN_MALE_NAMES.length)]; }

let gameCounter = 0;
const botLastWinGame = new Map();
BOT_IDS.forEach(id => botLastWinGame.set(id, 0));
let botGameHistory = [];
const BOT_NAME_REFRESH_MS = 12 * 60 * 60 * 1000;
const botNameAssignments = new Map();

// ---------- Winner history ----------
const winnerHistory = [];
const WINNER_HISTORY_MAX = 100;
function recordWinnerEntry(stake, winner, prizeEach, totalPrize, winningNumber) {
  const entry = {
    round: gameCounter,
    stake,
    name: winner.username,
    telegramId: winner.telegramId,
    card: winner.cardNumber || null,
    prize: prizeEach || 0,
    totalPrize: totalPrize || 0,
    winningNumber: winningNumber || null,
    time: new Date().toISOString()
  };
  winnerHistory.unshift(entry);
  if (winnerHistory.length > WINNER_HISTORY_MAX) winnerHistory.pop();
  return entry;
}

function getBotName(botId) {
  const now = Date.now();
  const entry = botNameAssignments.get(botId);
  if (entry && (now - entry.assignedAt) < BOT_NAME_REFRESH_MS) return entry.name;
  const newName = getRandomMaleEthiopianName();
  botNameAssignments.set(botId, { name: newName, assignedAt: now });
  return newName;
}

function addSingleBotToGame(botId, stake) {
  if (stake !== 20) return false;
  const game = getGame(stake);
  if (!game || game.status !== 'lobby') return false;
  if (game.players.find(p => p.telegramId === botId)) return false;
  const balance = botBalances.get(botId) || 0;
  if (balance < game.entryFee) return false;
  const available = [];
  for (let i = 1; i <= 100; i++) if (!game.takenCardNumbers.has(i)) available.push(i);
  if (!available.length) return false;
  const cardNumber = available[Math.floor(Math.random() * available.length)];
  const card = game.cardSet[cardNumber - 1];
  const botName = getBotName(botId);
  game.players.push({
    telegramId: botId, username: botName, card, markedNumbers: [],
    cardNumber, ip: '127.0.0.1', isBot: true, hasCalledBingo: false
  });
  game.takenCardNumbers.add(cardNumber);
  io.to(`stake_${stake}`).emit('cardTaken', { stake, number: cardNumber, takenNumbers: Array.from(game.takenCardNumbers) });
  broadcastPlayerCount(stake);
  notifyAdminClients();
  return true;
}

function updateBotsOnNumber(stake, number) {
  if (stake !== 20) return;
  const game = getGame(stake);
  if (game.status !== 'running') return;
  const bots = game.players.filter(p => p.isBot);
  for (const bot of bots) {
    const flat = bot.card.flat();
    if (flat.includes(number) && !bot.markedNumbers.includes(number)) bot.markedNumbers.push(number);
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
    if (!isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      getSocketByUserId(telegramId).then(socket => {
        if (socket) socket.emit('invalidBingo');
      });
      return;
    }
  }

  if (game.winningNumber === null) {
    game.winningNumber = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : 1;
  }
  game.winners.push({
    telegramId, username: player.username,
    isBot: player.isBot || false, isForced: force,
    cardNumber: player.cardNumber
  });

  if (!player.isBot && !force) {
    Audit.bingoCalled(`stake_${stake}`, telegramId, player.ip || null, {
      cardId: player.cardNumber, cardGrid: player.card,
      calledNumber: game.winningNumber, winType: 'bingo_line'
    });
  }

  if (!game.bingoGraceTimeout) {
    io.to(`stake_${stake}`).emit('multipleBingoPossible', { stake, message: 'Bingo claimed! Waiting for other potential winners...' });
    game.bingoGraceTimeout = setTimeout(() => endGameWithWinners(stake), 3000);
  }
}

function getGame(stake) { return games[stake]; }

function getAllPlayersList() {
  const allPlayers = [];
  for (const stake of [10, 20, 30, 50]) {
    const game = games[stake];
    game.players.forEach(p => {
      const user = users[p.telegramId];
      allPlayers.push({
        telegramId: p.telegramId, username: p.username,
        cardNumber: p.cardNumber, stake,
        telegram_handle: user ? user.telegram_handle : null,
        isBot: p.isBot || false
      });
    });
  }
  return allPlayers;
}

function notifyAdminClients() {
  adminNamespace.emit('admin:playersList', {
    players: getAllPlayersList(),
    gameStatus: { 10: games[10].status, 20: games[20].status, 30: games[30].status, 50: games[50].status }
  });
}

const publicNamespace = io.of('/public');
publicNamespace.on('connection', (socket) => {
  for (const stake of [10, 20, 30, 50]) {
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
  }
});

function broadcastPlayerCount(stake) {
  const game = getGame(stake);
  const count = game.players.length;
  io.emit('playersCount', { stake, count });
  publicNamespace.emit('playersCount', { stake, count });
}

function resetGame(stake) {
  const game = getGame(stake);
  clearInterval(game.callInterval);
  clearTimeout(game.lobbyTimer);
  clearTimeout(game.bingoGraceTimeout);
  for (const timeout of game.botTimeouts) clearTimeout(timeout);
  game.botTimeouts = [];
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

  if (stake === 20) {
    const lobbyDuration = 45000;
    for (const botId of BOT_IDS) {
      const delay = 1000 + Math.random() * (lobbyDuration - 2000);
      const timeout = setTimeout(() => {
        if (game.status === 'lobby' && !game.players.find(p => p.telegramId === botId)) {
          addSingleBotToGame(botId, stake);
        }
      }, delay);
      game.botTimeouts.push(timeout);
    }
  }

  io.to(`stake_${stake}`).emit('lobbyState', {
    stake, startsIn: 45,
    takenNumbers: Array.from(game.takenCardNumbers),
    playersCount: game.players.length
  });
  publicNamespace.emit('lobbyState', {
    stake, startsIn: 45,
    takenNumbers: Array.from(game.takenCardNumbers),
    playersCount: game.players.length
  });

  broadcastPlayerCount(stake);
  game.lobbyTimer = setTimeout(() => startGame(stake), 45000);
  notifyAdminClients();
}

async function startGame(stake) {
  const game = getGame(stake);
  for (const timeout of game.botTimeouts) clearTimeout(timeout);
  game.botTimeouts = [];

  const toRemove = [];
  for (const p of game.players) {
    if (p.isBot) {
      const bal = botBalances.get(p.telegramId) || 0;
      if (bal < game.entryFee) toRemove.push(p);
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
  game.prizePool = game.players.length === 1 ? totalEntryFees : 0.8 * totalEntryFees;
  game.status = 'running';
  game.calledNumbers = [];
  game.winningNumber = null;
  for (const p of game.players) if (p.isBot) p.hasCalledBingo = false;

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
    if (!available.length) { clearInterval(game.callInterval); endGameWithWinners(stake); return; }

    const number = available[Math.floor(Math.random() * available.length)];
    game.calledNumbers.push(number);
    io.to(`stake_${stake}`).emit('numberCalled', { stake, number, calledNumbers: game.calledNumbers });
    Audit.numberDrawn(`stake_${stake}`, { drawnNumber: number, drawIndex: game.calledNumbers.length, timestamp: new Date().toISOString() });

    if (stake === 20) updateBotsOnNumber(stake, number);
  }, 4000);
}

// ============================================================
//  ✅ WIN CONDITION – 2 completed lines required
//     Lines counted = 5 rows + 5 columns + 2 diagonals + 4 corners
//     Any TWO of these complete + lastCalled ∈ one of them = win.
// ============================================================
const LINES_REQUIRED_TO_WIN = 2;

function getLines(card) {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([card[r][0], card[r][1], card[r][2], card[r][3], card[r][4]]);
  for (let c = 0; c < 5; c++) lines.push([card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]]);
  lines.push([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
  lines.push([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);
  lines.push([card[0][0], card[0][4], card[4][0], card[4][4]]);
  return lines;
}
function isLineComplete(line, marked) { return line.every(val => val === 'FREE' || marked.includes(val)); }
function getCompletedLines(card, marked) { return getLines(card).filter(line => isLineComplete(line, marked)); }
function isBingoValidOnLastCall(card, marked, lastCalled) {
  if (lastCalled === null) return false;
  const completed = getCompletedLines(card, marked);
  if (completed.length < LINES_REQUIRED_TO_WIN) return false;
  return completed.some(line => line.includes(lastCalled));
}

async function endGameWithWinners(stake) {
  const game = getGame(stake);
  if (game.status === 'ended') return;
  game.status = 'ended';
  clearInterval(game.callInterval);
  gameCounter++;

  const totalEntryFees = game.players.length * game.entryFee;
  const houseProfit = totalEntryFees - game.prizePool;

  let gameRoundId = null;
  try {
    const { data, error } = await supabase.from('game_rounds').insert({
      total_entry_fees: totalEntryFees, prize_pool: game.prizePool,
      house_profit: houseProfit, stake
    }).select().single();
    if (error) throw error;
    gameRoundId = data.id;
  } catch (err) { console.error(`❌ Failed to insert game_round for stake ${stake}:`, err.message); }

  const adminCommissionChanges = new Set();

  if (gameRoundId && houseProfit > 0) {
    const adminGroups = {};
    for (const player of game.players) {
      if (player.isBot) continue;
      let user = users[player.telegramId];
      if (!user) {
        try { user = await loadUser(player.telegramId, player.username, null, null, true); }
        catch (e) { continue; }
      }
      const adminId = user?.admin_id || null;
      if (!adminId) continue;
      if (!adminGroups[adminId]) adminGroups[adminId] = { adminId, totalEntryFees: 0, playerCount: 0 };
      adminGroups[adminId].totalEntryFees += game.entryFee;
      adminGroups[adminId].playerCount++;
    }

    const adminCommissionFraction = parseFloat(process.env.ADMIN_COMMISSION_PERCENTAGE) || 0.40;
    const adminShareTotal = houseProfit * adminCommissionFraction;

    for (const [adminId, data] of Object.entries(adminGroups)) {
      const share = totalEntryFees > 0 ? (data.totalEntryFees / totalEntryFees) * adminShareTotal : 0;
      if (share > 0) {
        try {
          await supabase.from('game_admin_contributions').insert({
            game_round_id: gameRoundId,
            admin_id: parseInt(adminId),
            total_entry_fees: data.totalEntryFees,
            house_profit_share: share
          });
          adminCommissionChanges.add(parseInt(adminId));
        } catch (err) { console.error(`❌ Failed to record admin contribution:`, err.message); }
      }
    }
  }

  if (stake === 20) {
    const botsInGame = game.players.filter(p => p.isBot);
    for (const bot of botsInGame) {
      const winner = game.winners.find(w => w.telegramId === bot.telegramId);
      const prizeWon = winner ? (game.prizePool / game.winners.length) : 0;
      botGameHistory.push({
        botId: bot.telegramId, gameNumber: gameCounter,
        date: new Date().toISOString(), stake: game.entryFee, prizeWon
      });
    }
  }

  const realWinnersFinal = game.winners.filter(w => !w.isBot);
  if (realWinnersFinal.length > 0) {
    game.winners = game.winners.filter(w => !w.isBot);
  }

  if (game.winners.length > 0) {
    const finalRealWinners = game.winners.filter(w => !w.isBot);
    const finalBotWinners = game.winners.filter(w => w.isBot);
    let prizeEachReal = 0, prizeEachBot = 0;
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
          amount: prizeEachReal, currency: 'ETB', totalPrizePool: game.prizePool,
          totalWinners: game.winners.length, stake
        });
        detectRapidWins(`stake_${stake}`, w.telegramId, null);
      }
    }

    for (const w of finalBotWinners) {
      const bal = botBalances.get(w.telegramId) || 0;
      botBalances.set(w.telegramId, bal + prizeEachBot);
    }

    for (const w of game.winners) {
      const entry = recordWinnerEntry(stake, w,
        finalRealWinners.length > 0 ? prizeEachReal : prizeEachBot,
        game.prizePool, game.winningNumber);
      adminNamespace.emit('admin:winner', entry);
    }

    const winningCards = game.winners.map(w => w.cardNumber || 'Unknown');

    io.to(`stake_${stake}`).emit('gameEnded', {
      stake,
      winningCards: winningCards,
      prizeEach: finalRealWinners.length > 0 ? prizeEachReal : prizeEachBot,
      totalPrize: game.prizePool,
      winnerCount: game.winners.length,
      winningNumber: game.winningNumber
    });
  } else {
    io.to(`stake_${stake}`).emit('gameEnded', { stake, noWinner: true });
  }

  for (const adminId of adminCommissionChanges) {
    try {
      const { pending, earned } = await getAdminEarnings(adminId);
      const { data: adminRow } = await supabase.from('admins').select('commission_rate').eq('id', adminId).maybeSingle();
      emitToAdminId(adminId, 'commission:update', {
        version: Date.now(),
        pending, totalEarned: earned,
        rate: adminRow?.commission_rate || 0.40
      });
    } catch (e) { console.error('commission:update emit failed:', e.message); }
  }

  game.winners = [];
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;
  setTimeout(() => resetGame(stake), 5000);
  notifyAdminClients();
}

// ---------- Bot Admin Endpoints ----------
app.get('/admin/bots-status', (req, res) => {
  const { secret } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const botData = BOT_IDS.map(id => {
    const balance = botBalances.get(id) || 0;
    const lastWin = botLastWinGame.get(id) || 0;
    const game = getGame(20);
    const player = game.players.find(p => p.telegramId === id);
    return {
      id, username: player ? player.username : 'not in game',
      balance, lastWinGame: lastWin, inGame: !!player,
      cardNumber: player ? player.cardNumber : null
    };
  });
  res.json({ success: true, bots: botData, currentGame: gameCounter });
});

app.post('/admin/bot-reset-balance', async (req, res) => {
  const { secret, botId, newBalance } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!BOT_IDS.includes(botId)) return res.status(400).json({ error: 'Invalid bot ID' });
  const bal = Number(newBalance);
  if (isNaN(bal) || bal < 0) return res.status(400).json({ error: 'Balance must be non-negative' });
  botBalances.set(botId, bal);
  Audit.adminAction('BOT_BALANCE_RESET', 'admin', req.ip, { botId, newBalance: bal });
  res.json({ success: true, newBalance: bal });
});

app.get('/admin/bot-history', (req, res) => {
  const { secret, from, to } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  let history = botGameHistory;
  if (from) { const f = new Date(from); f.setHours(0,0,0,0); history = history.filter(e => new Date(e.date) >= f); }
  if (to) { const t = new Date(to); t.setHours(23,59,59,999); history = history.filter(e => new Date(e.date) <= t); }
  res.json({ success: true, history, from: from || null, to: to || null });
});

app.get('/admin-bots', (req, res) => res.sendFile(path.join(__dirname, 'admin-bots.html')));
app.get('/admin-bot-stats', (req, res) => res.sendFile(path.join(__dirname, 'admin-bot-stats.html')));

// ---------- Player deposit ----------
const handleDepositRequest = async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { phone, amount, payment_type, admin_id } = req.body;
  const amt = Number(amount);
  const photoFile = req.file;

  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  if (!admin_id) return res.status(400).json({ error: 'Please select a deposit account' });
  if (!photoFile) return res.status(400).json({ error: 'Please provide a screenshot/photo of your payment.' });

  try {
    const { data: admin, error: adminErr } = await supabase.from('admins')
      .select('id, name, telebirr_number, cbebirr_number, mpesa_number')
      .eq('id', admin_id).eq('is_active', true).maybeSingle();
    if (adminErr || !admin) return res.status(400).json({ error: 'Invalid deposit account' });

    const methodField = `${payment_type}_number`;
    if (!admin[methodField]) return res.status(400).json({ error: `Admin does not support ${payment_type} deposits` });

    const user = await loadUser(userId, null, null, null, false);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let photoUrl = null;
    if (photoFile) {
      const fileExt = photoFile.originalname.split('.').pop() || 'jpg';
      const fileName = `${uuidv4()}.${fileExt}`;
      const filePath = `deposit-proofs/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('deposit-photos').upload(filePath, photoFile.buffer, {
          contentType: photoFile.mimetype, cacheControl: '3600', upsert: false
        });
      if (uploadError) {
        let errorMsg = 'Failed to upload photo proof';
        if (uploadError.message.includes('bucket not found')) errorMsg = 'Storage bucket not configured. Please contact admin.';
        else if (uploadError.message.includes('permission')) errorMsg = 'Permission denied. Check Supabase storage policies.';
        return res.status(500).json({ error: errorMsg, details: uploadError.message });
      }
      const { data: publicUrlData } = supabase.storage.from('deposit-photos').getPublicUrl(filePath);
      photoUrl = publicUrlData?.publicUrl || null;
    }

    const { data, error } = await supabase.from('deposit_requests').insert({
      telegram_id: userId, username: user.username, amount: amt,
      status: 'pending', phone: phone || null, payment_type,
      transaction_reference: null, proof_photo_url: photoUrl,
      admin_id: admin.id, assigned_deposit_number: admin[methodField]
    }).select().single();
    if (error) throw error;

    Audit.depositInitiated(userId, req.ip, {
      transactionId: data.id.toString(), amount: amt, currency: 'ETB',
      method: payment_type, adminId: admin.id, adminName: admin.name,
      adminNumber: admin[methodField], hasPhoto: true
    });

    emitToAdminId(admin.id, 'deposit:new', data);

    res.json({
      success: true, requestId: data.id,
      message: `Deposit request of ${amt} ETB via ${payment_type} submitted to ${admin.name}.`,
      adminName: admin.name, adminNumber: admin[methodField]
    });
  } catch (err) { console.error('Deposit request error:', err.message); res.status(500).json({ error: err.message }); }
};

const uploadSingle = upload.single('photo');
app.post('/api/request-deposit', (req, res, next) => {
  uploadSingle(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 5MB)' });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected file field' });
      if (err.message && err.message.includes('Only images are allowed')) return res.status(400).json({ error: err.message });
    }
    handleDepositRequest(req, res);
  });
});

// ---------- Player withdrawal ----------
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

    let adminId = user.admin_id;
    let adminName = user.admin_name;
    if (!adminId) {
      const admins = await getAllAdmins();
      if (admins.length > 0) { adminId = admins[0].id; adminName = admins[0].name; }
    }

    const { data, error } = await supabase.from('withdrawal_requests').insert({
      telegram_id: userId, username: user.username, amount: amt,
      status: 'pending', phone_number: receiver, withdrawal_type,
      receiver_name: receiverName, admin_id: adminId, admin_name: adminName
    }).select().single();
    if (error) throw error;

    Audit.withdrawalRequested(userId, req.ip, {
      transactionId: data.id.toString(), amount: amt, currency: 'ETB',
      method: withdrawal_type, receiver, name: receiverName, adminId, adminName
    });

    if (adminId) emitToAdminId(adminId, 'withdrawal:new', data);

    res.json({
      success: true, requestId: data.id,
      message: `Withdrawal request of ${amt} ETB via ${withdrawal_type} to ${receiver} submitted.`
    });
  } catch (err) { console.error('Withdrawal request error:', err.message); res.status(500).json({ error: err.message }); }
});

// ---------- Admin endpoints (session-based) ----------

app.get('/admin/deposits', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  let query = supabase.from('deposit_requests').select('*').eq('admin_id', admin.id);
  const { from, to, method, status } = req.query;
  if (from) { const f = new Date(from); f.setHours(0,0,0,0); query = query.gte('created_at', f.toISOString()); }
  if (to) { const t = new Date(to); t.setHours(23,59,59,999); query = query.lte('created_at', t.toISOString()); }
  if (method && method !== 'all') query = query.eq('payment_type', method);
  if (status && status !== 'all') query = query.eq('status', status);
  else query = query.eq('status', 'pending');
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;

  const playerCount = await getAdminPlayerCount(admin.id);
  const rawDeposits = await getAdminDeposits(admin.id);
  const approvedToday = await getAdminDeposits(admin.id, 'approved');
  const depositBalance = await getAdminHoldingBalance(admin.id);

  res.json({
    requests: data,
    admin: { id: admin.id, name: admin.name, phone: admin.phone, deposit_number: admin.deposit_number },
    stats: {
      playerCount, totalDeposits: depositBalance, rawDeposits, depositBalance,
      pendingCount: data.filter(d => d.status === 'pending').length, approvedToday
    }
  });
});

app.get('/admin/deposits/:id', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const { data, error } = await supabase.from('deposit_requests').select('*')
      .eq('id', req.params.id).eq('admin_id', admin.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({ request: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/withdrawals', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  let query = supabase.from('withdrawal_requests').select('*').eq('admin_id', admin.id);
  const { from, to, method, status } = req.query;
  if (from) { const f = new Date(from); f.setHours(0,0,0,0); query = query.gte('created_at', f.toISOString()); }
  if (to) { const t = new Date(to); t.setHours(23,59,59,999); query = query.lte('created_at', t.toISOString()); }
  if (method && method !== 'all') query = query.eq('withdrawal_type', method);
  if (status && status !== 'all') query = query.eq('status', status);
  else query = query.eq('status', 'pending');
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  res.json({ requests: data, admin: { id: admin.id, name: admin.name, phone: admin.phone } });
});

app.get('/admin/withdrawals/:id', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const { data, error } = await supabase.from('withdrawal_requests').select('*')
      .eq('id', req.params.id).eq('admin_id', admin.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({ request: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/holding-balance', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const holding = await getAdminHoldingBalance(admin.id);
    res.json({ success: true, holding });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ✅ /admin/process-deposit — accepts ADMIN_SECRET OR admin session
// ============================================================
app.post('/admin/process-deposit', async (req, res) => {
  const { requestId, action, secret } = req.body;

  let actingAdmin = null;
  let isSuper = false;

  if (secret === ADMIN_SECRET) {
    isSuper = true;
  } else {
    actingAdmin = await getAdminFromSession(req);
    if (!actingAdmin) {
      return res.status(401).json({ error: 'Session expired or deactivated' });
    }
  }

  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    let query = supabase.from('deposit_requests').select('*').eq('id', requestId);
    if (!isSuper) query = query.eq('admin_id', actingAdmin.id);
    const { data: reqData, error: fetchErr } = await query.maybeSingle();

    if (fetchErr || !reqData) {
      return res.status(404).json({ error: isSuper ? 'Request not found' : 'Request not found or not assigned to you' });
    }
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const ownerAdminId = reqData.admin_id;
    const actingAdminId = isSuper ? (ownerAdminId || null) : actingAdmin.id;
    const actingAdminName = isSuper ? ('super:' + (ownerAdminId || '-')) : actingAdmin.name;

    if (action === 'approve') {
      if (!isSuper && ownerAdminId) {
        const holding = await getAdminHoldingBalance(ownerAdminId);
        if (holding + reqData.amount > 1500) {
          return res.status(400).json({
            error: `Admin's total approved deposits would exceed 1500 ETB (current: ${holding.toFixed(0)} ETB). Please withdraw excess to super admin before approving more deposits.`
          });
        }
      }

      const user = await loadUser(reqData.telegram_id, null, null, null, true);
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.balance += reqData.amount;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);

      const processedAt = new Date().toISOString();
      await supabase.from('deposit_requests')
        .update({ status: 'approved', processed_at: processedAt })
        .eq('id', requestId);

      Audit.depositCompleted(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(), providerRef: reqData.id.toString(),
        amount: reqData.amount, currency: 'ETB', method: reqData.payment_type || 'unknown',
        adminId: actingAdminId, adminName: actingAdminName
      });

      if (!user.first_deposit_amount || user.first_deposit_amount === 0) {
        user.first_deposit_amount = reqData.amount;
        await supabase.from('users').update({ first_deposit_amount: user.first_deposit_amount }).eq('telegram_id', reqData.telegram_id);
      }

      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) {
        playerSocket.emit('balanceUpdate', user.balance);
        playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount });
      }

      const updated = { ...reqData, status: 'approved', processed_at: processedAt, version: Date.now() };
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'deposit:updated', updated);
      io.to(`stake_10`).to(`stake_20`).to(`stake_30`).to(`stake_50`).emit('admin:playerBalance', { telegram_id: reqData.telegram_id, balance: user.balance });

      res.json({ success: true, newBalance: user.balance });
    } else {
      const processedAt = new Date().toISOString();
      await supabase.from('deposit_requests')
        .update({ status: 'rejected', processed_at: processedAt })
        .eq('id', requestId);
      Audit.depositFailed(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(), amount: reqData.amount,
        reason: 'rejected_by_admin', adminId: actingAdminId, adminName: actingAdminName
      });
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });

      const updated = { ...reqData, status: 'rejected', processed_at: processedAt, version: Date.now() };
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'deposit:updated', updated);

      res.json({ success: true });
    }
  } catch (err) { console.error('Process deposit error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/admin/stats', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const playerCount = await getAdminPlayerCount(admin.id);
    const { data: deposits } = await supabase.from('deposit_requests').select('amount, status, created_at').eq('admin_id', admin.id);
    const rawDeposits = deposits.filter(d => d.status === 'approved').reduce((s, d) => s + Number(d.amount), 0);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayDepositsFromRequests = deposits
      .filter(d => d.status === 'approved' && new Date(d.created_at) >= today)
      .reduce((s, d) => s + Number(d.amount), 0);

    const { data: adjustments, error: adjErr } = await supabase.from('admin_deposit_adjustments')
      .select('amount, created_at').eq('admin_id', admin.id).gt('amount', 0);
    if (adjErr) throw adjErr;
    const adjustmentTotal = adjustments.reduce((s, a) => s + Number(a.amount), 0);
    const adjustmentToday = adjustments.filter(a => new Date(a.created_at) >= today).reduce((s, a) => s + Number(a.amount), 0);

    const totalDeposits = rawDeposits + adjustmentTotal;
    const todayDeposits = todayDepositsFromRequests + adjustmentToday;

    const { data: withdrawals } = await supabase.from('withdrawal_requests').select('amount, status').eq('admin_id', admin.id);
    const totalWithdrawals = withdrawals.filter(w => w.status === 'approved').reduce((s, w) => s + Number(w.amount), 0);
    const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
    const pendingDeposits = deposits.filter(d => d.status === 'pending').length;

    const depositBalance = await getAdminHoldingBalance(admin.id);
    const { pending: pendingEarnings, earned: totalEarned } = await getAdminEarnings(admin.id);

    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, phone: admin.phone, deposit_number: admin.deposit_number },
      stats: {
        playerCount, availableBalance: pendingEarnings, totalEarned,
        depositBalance, rawDeposits, totalDeposits, todayDeposits,
        totalWithdrawals, pendingWithdrawals, pendingDeposits
      }
    });
  } catch (err) { console.error('Error fetching admin stats:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/admin/players', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const players = await getAdminPlayers(admin.id);
    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, phone: admin.phone },
      players: players,
      count: players.length
    });
  } catch (err) {
    console.error('Error fetching admin players:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/update-player-balance', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  const { telegramId, amount, operation } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'Telegram ID required' });
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
  if (!['add', 'subtract'].includes(operation)) return res.status(400).json({ error: 'Operation must be "add" or "subtract"' });

  try {
    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('telegram_id', telegramId).maybeSingle();
    if (userErr || !user) return res.status(404).json({ error: 'Player not found' });
    if (user.admin_id !== admin.id) return res.status(403).json({ error: 'This player is not assigned to you' });

    if (operation === 'add') {
      const currentHolding = await getAdminHoldingBalance(admin.id);
      if (currentHolding + amt > 1500) {
        return res.status(400).json({
          error: `Cannot add ${amt} ETB. Admin holding balance would exceed 1500 ETB (current: ${currentHolding.toFixed(0)} ETB). Please withdraw excess to super admin.`
        });
      }
    }

    const oldBalance = Number(user.balance);
    let newBalance = oldBalance;
    if (operation === 'add') newBalance += amt;
    else {
      if (oldBalance < amt) return res.status(400).json({ error: 'Insufficient player balance' });
      newBalance -= amt;
    }

    const { error: updateErr } = await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegramId);
    if (updateErr) throw updateErr;

    const adjustmentAmount = operation === 'add' ? amt : -amt;
    const { error: adjErr } = await supabase.from('admin_deposit_adjustments').insert({
      admin_id: admin.id, amount: adjustmentAmount,
      type: 'manual_balance_adjustment',
      description: `Manual ${operation} of ${amt} ETB for player ${telegramId}`,
      created_by: admin.id, created_at: new Date().toISOString()
    });
    if (adjErr) console.error('Failed to record adjustment:', adjErr.message);

    if (users[telegramId]) users[telegramId].balance = newBalance;
    else await loadUser(telegramId, user.username, user.telegram_handle, null, true);

    await Audit.adminAction('ADMIN_MANUAL_BALANCE_ADJUST', admin.id, req.ip, {
      targetUserId: telegramId, operation, amount: amt, oldBalance, newBalance
    });

    const playerSocket = await getSocketByUserId(telegramId);
    if (playerSocket) playerSocket.emit('balanceUpdate', newBalance);

    emitToAdminId(admin.id, 'player:balance', { telegram_id: telegramId, balance: newBalance });

    res.json({ success: true, newBalance, message: `Balance ${operation}ed by ${amt} ETB` });
  } catch (err) { console.error('Error updating player balance:', err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ✅ /admin/process-withdrawal — accepts ADMIN_SECRET OR admin session
// ============================================================
app.post('/admin/process-withdrawal', async (req, res) => {
  const { requestId, action, secret } = req.body;

  let actingAdmin = null;
  let isSuper = false;

  if (secret === ADMIN_SECRET) {
    isSuper = true;
  } else {
    actingAdmin = await getAdminFromSession(req);
    if (!actingAdmin) {
      return res.status(401).json({ error: 'Session expired or deactivated' });
    }
  }

  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    let query = supabase.from('withdrawal_requests').select('*').eq('id', requestId);
    if (!isSuper) query = query.eq('admin_id', actingAdmin.id);
    const { data: reqData, error: fetchErr } = await query.maybeSingle();

    if (fetchErr || !reqData) {
      return res.status(404).json({ error: isSuper ? 'Request not found' : 'Request not found or not assigned to you' });
    }
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const ownerAdminId = reqData.admin_id;
    const actingAdminId = isSuper ? (ownerAdminId || null) : actingAdmin.id;
    const actingAdminName = isSuper ? ('super:' + (ownerAdminId || '-')) : actingAdmin.name;

    if (action === 'approve') {
      const user = await loadUser(reqData.telegram_id, null, null, null, true);
      if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
      user.balance -= reqData.amount;
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);

      const processedAt = new Date().toISOString();
      await supabase.from('withdrawal_requests')
        .update({ status: 'approved', processed_at: processedAt })
        .eq('id', requestId);

      Audit.withdrawalCompleted(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(), amount: reqData.amount, currency: 'ETB',
        method: reqData.withdrawal_type || 'N/A', receiver: reqData.phone_number,
        adminId: actingAdminId, adminName: actingAdminName
      });
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) {
        playerSocket.emit('balanceUpdate', user.balance);
        playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number });
      }

      const updated = { ...reqData, status: 'approved', processed_at: processedAt, version: Date.now() };
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'withdrawal:updated', updated);

      res.json({ success: true, newBalance: user.balance });
    } else {
      const processedAt = new Date().toISOString();
      await supabase.from('withdrawal_requests')
        .update({ status: 'rejected', processed_at: processedAt })
        .eq('id', requestId);
      Audit.withdrawalRejected(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(), amount: reqData.amount,
        reason: 'rejected_by_admin', adminId: actingAdminId, adminName: actingAdminName
      });
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });

      const updated = { ...reqData, status: 'rejected', processed_at: processedAt, version: Date.now() };
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'withdrawal:updated', updated);

      res.json({ success: true });
    }
  } catch (err) { console.error('Process withdrawal error:', err.message); res.status(500).json({ error: err.message }); }
});

// ---------- Daily Commission ----------
const DAILY_COMMISSION_HOUR = 0;
const DAILY_COMMISSION_MINUTE = 0;
async function calculateDailyCommissions() {
  console.log('⏰ Running daily commission calculation...');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  try {
    const { data: admins, error: adminErr } = await supabase.from('admins').select('id, name').eq('is_active', true);
    if (adminErr) throw adminErr;

    for (const admin of admins) {
      const { data: contributions, error: contribErr } = await supabase.from('game_admin_contributions')
        .select('house_profit_share, total_entry_fees, created_at')
        .eq('admin_id', admin.id)
        .gte('created_at', yesterday.toISOString()).lt('created_at', today.toISOString());
      if (contribErr) throw contribErr;

      if (contributions && contributions.length > 0) {
        const totalCommission = contributions.reduce((s, c) => s + Number(c.house_profit_share), 0);
        const totalEntryFees = contributions.reduce((s, c) => s + Number(c.total_entry_fees || 0), 0);
        const totalHouseProfit = contributions.reduce((s, c) => s + Number(c.house_profit_share || 0), 0);
        if (totalCommission > 0) {
          const { data: existing } = await supabase.from('admin_daily_commissions')
            .select('id, status').eq('admin_id', admin.id).eq('date', yesterdayStr).maybeSingle();
          if (existing) {
            if (existing.status !== 'paid') {
              await supabase.from('admin_daily_commissions').update({
                total_entry_fees: totalEntryFees, total_house_profit: totalHouseProfit,
                commission_amount: totalCommission
              }).eq('id', existing.id);
            }
          } else {
            await supabase.from('admin_daily_commissions').insert({
              admin_id: admin.id, date: yesterdayStr,
              total_entry_fees: totalEntryFees, total_house_profit: totalHouseProfit,
              commission_amount: totalCommission, status: 'pending'
            });
          }
        }
      }
    }
  } catch (err) { console.error('❌ Daily commission calculation error:', err.message); }
}
function scheduleDailyCommission() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(DAILY_COMMISSION_HOUR, DAILY_COMMISSION_MINUTE, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  setTimeout(() => { calculateDailyCommissions(); setInterval(calculateDailyCommissions, 24 * 60 * 60 * 1000); }, nextRun - now);
}
scheduleDailyCommission();

app.get('/admin/daily-commissions', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const { data: dailyCommissions, error } = await supabase.from('admin_daily_commissions').select('*')
      .eq('admin_id', admin.id).order('date', { ascending: false }).limit(30);
    if (error) throw error;
    const { data: pendingEarnings } = await supabase.from('admin_daily_commissions')
      .select('commission_amount').eq('admin_id', admin.id).eq('status', 'pending');
    const totalPending = pendingEarnings.reduce((s, d) => s + Number(d.commission_amount), 0);
    const { data: paidEarnings } = await supabase.from('admin_daily_commissions')
      .select('commission_amount').eq('admin_id', admin.id).eq('status', 'paid');
    const totalPaid = paidEarnings.reduce((s, d) => s + Number(d.commission_amount), 0);
    res.json({
      success: true, daily: dailyCommissions,
      stats: { totalEarned: totalPaid, totalPending, totalPaid, totalAvailable: totalPending },
      admin: { id: admin.id, name: admin.name, commission_rate: admin.commission_rate }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/live-commission', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ success: false, error: 'Session expired or deactivated' }); }
  try {
    const { data: contributions, error: contribErr } = await supabase.from('game_admin_contributions')
      .select('house_profit_share, total_entry_fees, created_at, game_round_id').eq('admin_id', admin.id);
    if (contribErr) throw contribErr;

    const { data: paidCommissions, error: paidErr } = await supabase.from('admin_daily_commissions')
      .select('commission_amount, status, date').eq('admin_id', admin.id);
    if (paidErr) throw paidErr;

    const paidDates = new Set((paidCommissions || []).filter(c => c.status === 'paid').map(c => c.date));

    const dailyTotals = {};
    let totalPending = 0, totalPaid = 0;
    if (contributions) {
      for (const contrib of contributions) {
        const dateStr = new Date(contrib.created_at).toISOString().split('T')[0];
        const share = Number(contrib.house_profit_share) || 0;
        const fees = Number(contrib.total_entry_fees) || 0;
        if (!dailyTotals[dateStr]) dailyTotals[dateStr] = { date: dateStr, totalCommission: 0, totalEntryFees: 0, isPaid: paidDates.has(dateStr) };
        dailyTotals[dateStr].totalCommission += share;
        dailyTotals[dateStr].totalEntryFees += fees;
      }
    }
    const rounds = [];
    for (const [dateStr, data] of Object.entries(dailyTotals)) {
      rounds.push({ date: dateStr, total_entry_fees: data.totalEntryFees, commission_amount: data.totalCommission, status: data.isPaid ? 'paid' : 'pending' });
      if (data.isPaid) totalPaid += data.totalCommission; else totalPending += data.totalCommission;
    }
    rounds.sort((a, b) => new Date(b.date) - new Date(a.date));

    let totalEarned = 0;
    if (paidCommissions) for (const c of paidCommissions) if (c.status === 'paid') totalEarned += Number(c.commission_amount) || 0;

    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, commission_rate: admin.commission_rate },
      stats: { pending: totalPending, paid: totalPaid, totalEarned, totalPending, totalAvailable: totalPending },
      rounds
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/request-withdrawal', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  const { amount, phone, withdrawal_type, receiver_name } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!phone || !receiver_name) return res.status(400).json({ error: 'Phone and receiver name required' });

  try {
    const { pending } = await getAdminEarnings(admin.id);
    if (pending < amt) return res.status(400).json({ error: `Insufficient pending earnings. Available: ${pending.toFixed(0)} ETB` });

    const { data, error } = await supabase.from('admin_withdrawal_requests').insert({
      admin_id: admin.id, amount: amt, phone, withdrawal_type, receiver_name, status: 'pending'
    }).select().single();
    if (error) throw error;
    res.json({ success: true, request: data });
  } catch (err) { console.error('Admin withdrawal request error:', err.message); res.status(500).json({ error: err.message }); }
});

// ---------- Super Admin helpers ----------
async function authSuperAdmin(req, res) {
  const secret = req.query.secret || req.body.secret;
  if (secret && secret === ADMIN_SECRET) return { success: true, adminId: null, via: 'secret' };
  if (req.session.adminId) {
    const isSuper = await isSuperAdmin(req.session.adminId);
    if (isSuper) return { success: true, adminId: req.session.adminId, via: 'session' };
  }
  return { success: false, error: 'Unauthorized – valid secret or super admin session required' };
}

app.get('/super-admin/admins', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  try {
    const { data: admins, error } = await supabase.from('admins').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const adminsWithStats = await Promise.all(admins.map(async (admin) => {
      const playerCount = await getAdminPlayerCount(admin.id);
      const rawDeposits = await getAdminDeposits(admin.id);
      const { data: pendingDeposits } = await supabase.from('deposit_requests').select('count').eq('admin_id', admin.id).eq('status', 'pending');
      const { data: withdrawals } = await supabase.from('withdrawal_requests').select('amount, status').eq('admin_id', admin.id);
      const totalWithdrawals = withdrawals.filter(w => w.status === 'approved').reduce((s, w) => s + Number(w.amount), 0);
      const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
      const { pending: totalPendingEarnings, earned: totalEarned } = await getAdminEarnings(admin.id);
      const holdingBalance = await getAdminHoldingBalance(admin.id);
      return { ...admin, stats: {
        playerCount, totalDeposits: holdingBalance, rawDeposits, holdingBalance,
        pendingDeposits: pendingDeposits?.[0]?.count || 0,
        totalWithdrawals, pendingWithdrawals, totalPendingEarnings, totalEarned
      }};
    }));
    res.json({ success: true, admins: adminsWithStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/super-admin/admin/:adminId', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  try {
    const { adminId } = req.params;
    const { data: admin, error } = await supabase.from('admins').select('*').eq('id', adminId).maybeSingle();
    if (error || !admin) return res.status(404).json({ error: 'Admin not found' });

    const players = await getAdminPlayers(adminId);
    const { data: deposits } = await supabase.from('deposit_requests').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }).limit(20);
    const { data: withdrawals } = await supabase.from('withdrawal_requests').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }).limit(20);
    const { data: earnings } = await supabase.from('admin_daily_commissions').select('*').eq('admin_id', adminId).order('date', { ascending: false }).limit(30);
    const { data: adminWithdrawals } = await supabase.from('admin_withdrawal_requests').select('*').eq('admin_id', adminId).eq('status', 'pending').order('created_at', { ascending: false });
    const { pending: totalPendingEarnings, earned: totalEarned } = await getAdminEarnings(adminId);
    const holdingBalance = await getAdminHoldingBalance(adminId);
    const { data: adjustments, error: adjErr } = await supabase.from('admin_deposit_adjustments').select('*').eq('admin_id', adminId).order('created_at', { ascending: false });
    if (adjErr) throw adjErr;

    res.json({
      success: true, admin,
      stats: { players: players.length, deposits, withdrawals, earnings, adminWithdrawals, totalPendingEarnings, totalEarned, holdingBalance, adjustments: adjustments || [] }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/toggle-admin', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { adminId, isActive } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });
  try {
    if (auth.via === 'session' && parseInt(adminId) === req.session.adminId) return res.status(400).json({ error: 'Cannot change your own status' });
    const { error } = await supabase.from('admins').update({ is_active: isActive }).eq('id', adminId);
    if (error) throw error;
    Audit.adminAction('SUPER_ADMIN_TOGGLE_ADMIN', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, newStatus: isActive });
    res.json({ success: true, message: `Admin ${isActive ? 'activated' : 'deactivated'}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/update-commission', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { adminId, commissionRate } = req.body;
  if (!adminId || commissionRate === undefined) return res.status(400).json({ error: 'Admin ID and commission rate required' });
  if (commissionRate < 0 || commissionRate > 1) return res.status(400).json({ error: 'Commission rate must be between 0 and 1' });
  try {
    const { error } = await supabase.from('admins').update({ commission_rate: commissionRate }).eq('id', adminId);
    if (error) throw error;
    Audit.adminAction('SUPER_ADMIN_UPDATE_COMMISSION', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, newCommissionRate: commissionRate });
    res.json({ success: true, message: 'Commission rate updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/toggle-deposit-acceptance', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { adminId, acceptDeposits } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });
  if (acceptDeposits === undefined) return res.status(400).json({ error: 'acceptDeposits boolean required' });
  try {
    const { error } = await supabase.from('admins').update({ accept_deposits: acceptDeposits }).eq('id', adminId);
    if (error) throw error;
    Audit.adminAction('SUPER_ADMIN_TOGGLE_DEPOSIT_ACCEPTANCE', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, acceptDeposits });
    res.json({ success: true, message: `Deposit acceptance ${acceptDeposits ? 'enabled' : 'disabled'}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/adjust-deposit-balance', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { adminId, amount, description = '' } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });
  if (amount === undefined || isNaN(Number(amount)) || amount === 0) return res.status(400).json({ error: 'Valid non-zero amount required (negative to deduct)' });
  const amt = Number(amount);
  try {
    const { data: admin, error: adminErr } = await supabase.from('admins').select('id').eq('id', adminId).eq('is_active', true).maybeSingle();
    if (adminErr || !admin) return res.status(404).json({ error: 'Admin not found' });

    const { data: newAdj, error: insertErr } = await supabase.from('admin_deposit_adjustments').insert({
      admin_id: adminId, amount: amt, type: 'super_admin_manual',
      description: description || (amt < 0 ? 'Super admin deduction' : 'Super admin addition'),
      created_by: auth.adminId || null, created_at: new Date().toISOString()
    }).select().single();
    if (insertErr) throw insertErr;

    const newBalance = await getAdminHoldingBalance(adminId);
    Audit.adminAction('SUPER_ADMIN_ADJUST_DEPOSIT', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, amount: amt, newBalance, description: newAdj.description });
    res.json({ success: true, message: 'Deposit balance adjusted', adjustment: newAdj, newBalance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/send-telegram-message', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'Missing userId or message' });
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ success: false, error: 'BOT_TOKEN not configured' });
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text: message, parse_mode: 'HTML' })
    });
    const data = await response.json();
    if (data.ok) res.json({ success: true, result: data.result });
    else {
      let errorMsg = data.description || 'Telegram API error';
      if (errorMsg.includes('chat not found')) errorMsg = 'User has not started the bot yet. Ask them to open the game first.';
      throw new Error(errorMsg);
    }
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/super-admin/admin-withdrawals', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  try {
    const { status = 'pending', limit = 50, from, to, adminId } = req.query;
    let query = supabase.from('admin_withdrawal_requests').select('*, admins(name, phone)')
      .order('created_at', { ascending: false }).limit(Math.min(parseInt(limit), 100));
    if (status !== 'all') query = query.eq('status', status);
    if (adminId && adminId !== 'all') query = query.eq('admin_id', adminId);
    if (from) { const f = new Date(from); f.setHours(0,0,0,0); query = query.gte('created_at', f.toISOString()); }
    if (to) { const t = new Date(to); t.setHours(23,59,59,999); query = query.lte('created_at', t.toISOString()); }
    const { data: requests, error } = await query;
    if (error) throw error;
    res.json({ success: true, requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/super-admin/process-admin-withdrawal', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  const { requestId, action } = req.body;
  if (!requestId || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Request ID and valid action required' });
  try {
    const { data: reqData, error: fetchErr } = await supabase.from('admin_withdrawal_requests').select('*').eq('id', requestId).single();
    if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });

    if (action === 'approve') {
      await markContributionsAsPaid(reqData.admin_id, reqData.amount);
      await supabase.from('admin_withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
      Audit.adminAction('SUPER_ADMIN_APPROVE_WITHDRAWAL', auth.adminId || 'secret', req.ip, { targetAdminId: reqData.admin_id, amount: reqData.amount, requestId });
      res.json({ success: true, message: 'Withdrawal approved' });
    } else {
      await supabase.from('admin_withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
      Audit.adminAction('SUPER_ADMIN_REJECT_WITHDRAWAL', auth.adminId || 'secret', req.ip, { targetAdminId: reqData.admin_id, amount: reqData.amount, requestId });
      res.json({ success: true, message: 'Withdrawal rejected' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  /super-admin/platform-stats
//  (reconstructed — your paste cut off at "let paidE…")
// ============================================================
app.get('/super-admin/platform-stats', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });
  try {
    const { from, to, adminId } = req.query;

    let userQuery = supabase.from('users').select('*', { count: 'exact', head: true });
    let adminQuery = supabase.from('admins').select('*', { count: 'exact', head: true }).eq('is_active', true);
    let depositQuery = supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    let withdrawalQuery = supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    let roundsQuery = supabase.from('game_rounds').select('house_profit, created_at');
    let paidEarningsQuery = supabase.from('admin_daily_commissions').select('commission_amount').eq('status', 'paid');

    if (from) {
      const f = new Date(from); f.setHours(0, 0, 0, 0);
      depositQuery = depositQuery.gte('created_at', f.toISOString());
      withdrawalQuery = withdrawalQuery.gte('created_at', f.toISOString());
      roundsQuery = roundsQuery.gte('created_at', f.toISOString());
    }
    if (to) {
      const t = new Date(to); t.setHours(23, 59, 59, 999);
      depositQuery = depositQuery.lte('created_at', t.toISOString());
      withdrawalQuery = withdrawalQuery.lte('created_at', t.toISOString());
      roundsQuery = roundsQuery.lte('created_at', t.toISOString());
    }
    if (adminId && adminId !== 'all') {
      depositQuery = depositQuery.eq('admin_id', adminId);
      withdrawalQuery = withdrawalQuery.eq('admin_id', adminId);
      paidEarningsQuery = paidEarningsQuery.eq('admin_id', adminId);
    }

    const [
      { count: totalUsers, error: userErr },
      { count: activeAdmins, error: adminErr },
      { data: deposits, error: depErr },
      { data: withdrawals, error: wdErr },
      { data: rounds, error: rndErr },
      { data: paidEarnings, error: payErr }
    ] = await Promise.all([
      userQuery, adminQuery, depositQuery, withdrawalQuery, roundsQuery, paidEarningsQuery
    ]);

    if (userErr) throw userErr;
    if (adminErr) throw adminErr;
    if (depErr) throw depErr;
    if (wdErr) throw wdErr;
    if (rndErr) throw rndErr;
    if (payErr) throw payErr;

    const totalDeposits = (deposits || []).reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalWithdrawals = (withdrawals || []).reduce((s, w) => s + Number(w.amount || 0), 0);
    const totalHouseProfit = (rounds || []).reduce((s, r) => s + Number(r.house_profit || 0), 0);
    const totalPaidEarnings = (paidEarnings || []).reduce((s, p) => s + Number(p.commission_amount || 0), 0);

    res.json({
      success: true,
      range: { from: from || null, to: to || null, adminId: adminId || 'all' },
      stats: {
        totalUsers: totalUsers || 0,
        activeAdmins: activeAdmins || 0,
        totalDeposits,
        totalWithdrawals,
        totalHouseProfit,
        totalPaidEarnings,
        totalGames: (rounds || []).length
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ✅ Admin Socket Namespace & emitToAdminId
//  (reconstructed — your paste ended before this was defined)
// ============================================================
const adminNamespace = io.of('/admin');

function emitToAdminId(adminId, event, data) {
  try {
    adminNamespace.to(`admin_${adminId}`).emit(event, data);
  } catch (e) {
    console.error('emitToAdminId error:', e.message);
  }
}

adminNamespace.on('connection', async (socket) => {
  const sess = socket.request.session;
  const adminId = sess && sess.adminId ? sess.adminId : null;

  if (!adminId) {
    socket.emit('admin:error', { error: 'Not authenticated' });
    socket.disconnect(true);
    return;
  }

  // Verify the admin still exists and is active
  const { data: admin, error } = await supabase.from('admins').select('id, name, is_active')
    .eq('id', adminId).eq('is_active', true).maybeSingle();

  if (error || !admin) {
    socket.emit('admin:error', { error: 'Admin deactivated or not found' });
    socket.disconnect(true);
    return;
  }

  socket.adminId = admin.id;
  socket.join(`admin_${admin.id}`);
  socket.emit('admin:ready', { adminId: admin.id, adminName: admin.name });

  // Send current snapshot
  socket.emit('admin:playersList', {
    players: getAllPlayersList(),
    gameStatus: {
      10: games[10].status, 20: games[20].status,
      30: games[30].status, 50: games[50].status
    }
  });

  if (winnerHistory.length > 0) {
    socket.emit('admin:winnerHistory', { history: winnerHistory });
  }

  socket.on('disconnect', () => { /* noop */ });
});

// ---------- Player socket namespace (default io) ----------
io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (sess && sess.userId) socket.userId = String(sess.userId);

  socket.on('joinStake', ({ stake }) => {
    if (![10, 20, 30, 50].includes(Number(stake))) return;
    const room = `stake_${stake}`;
    socket.join(room);
    const game = getGame(stake);
    socket.emit('lobbyState', {
      stake: Number(stake),
      startsIn: game.status === 'lobby' ? Math.max(0, Math.round((game.lobbyEndTime - Date.now()) / 1000)) : 0,
      takenNumbers: Array.from(game.takenCardNumbers),
      playersCount: game.players.length,
      status: game.status
    });
    if (game.status === 'running') {
      socket.emit('gameStarted', { stake: Number(stake), prizePool: game.prizePool, playersCount: game.players.length });
      socket.emit('numberCalled', { stake: Number(stake), number: game.calledNumbers[game.calledNumbers.length - 1], calledNumbers: game.calledNumbers });
    }
  });

  socket.on('leaveStake', ({ stake }) => {
    if (![10, 20, 30, 50].includes(Number(stake))) return;
    socket.leave(`stake_${stake}`);
  });
});

// ---------- Server listen ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo server listening on port ${PORT}`);
  console.log(`   Win condition: ${LINES_REQUIRED_TO_WIN} completed lines required`);
  for (const stake of [10, 20, 30, 50]) {
    resetGame(stake);
  }
});
