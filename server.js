// ================================================================
//  server.js – Fully Secured & Optimized Bingo Server
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

// ---------- Suspicious Activity Detector (Memory Leak Fixed) ----------
const winTimestamps = new Map();
const WINDOW_MS = 120_000;
const MAX_WINS_IN_WINDOW = 3;
function detectRapidWins(roomId, userId, ip) {
  if (!winTimestamps.has(userId)) winTimestamps.set(userId, []);
  const times = winTimestamps.get(userId);
  const now = Date.now();
  times.push(now);
  const recent = times.filter(t => now - t <= WINDOW_MS);
  
  if (recent.length === 0) {
    winTimestamps.delete(userId);
  } else {
    winTimestamps.set(userId, recent);
  }

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

// ============================================================
//  ✅ /admin/set-balance (Atomic RPC)
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

    const { data: rpcData, error: rpcErr } = await supabase.rpc('increment_balance', {
      user_id: strId,
      amount: delta
    });
    if (rpcErr) throw rpcErr;

    if (users[strId]) users[strId].balance = newBal;
    else await loadUser(strId, existing.username, existing.telegram_handle, null, true);

    if (delta > 0) {
      try {
        await supabase.from('deposit_requests').insert({
          telegram_id: strId, username: existing.username || 'Player',
          amount: delta, status: 'approved', phone: 'manual', payment_type: 'manual',
          transaction_reference: null, proof_photo_url: null, assigned_deposit_number: null,
          admin_id: existing.admin_id || (authorizedAdmin ? authorizedAdmin.id : null),
          processed_at: new Date().toISOString()
        });
      } catch (e) {}
    } else if (delta < 0) {
      try {
        await supabase.from('withdrawal_requests').insert({
          telegram_id: strId, username: existing.username || 'Player',
          amount: Math.abs(delta), status: 'approved', phone_number: 'manual',
          withdrawal_type: 'manual', receiver_name: 'manual adjustment',
          admin_id: existing.admin_id || (authorizedAdmin ? authorizedAdmin.id : null),
          admin_name: existing.admin_name || (authorizedAdmin ? authorizedAdmin.name : 'super'),
          processed_at: new Date().toISOString()
        });
      } catch (e) {}
    }

    Audit.adminAction('ADMIN_SET_BALANCE', authorizedAdmin ? authorizedAdmin.id : 'super', req.ip, { targetUserId: strId, oldBalance, newBalance: newBal, delta });

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
    botTimeouts: [], forceActive: false, forcedBotId: null
  };
}

const games = { 10: createGameState(10), 20: createGameState(20), 30: createGameState(30), 50: createGameState(50) };

const BOT_IDS = ['1945854','8696548','78963521','45896872','1236584','4567890','9876543','3216549','7539512'];
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
let globalForcedBotId = null;
let botGameHistory = [];
const BOT_NAME_REFRESH_MS = 12 * 60 * 60 * 1000;
const botNameAssignments = new Map();

// ---------- Winner history ----------
const winnerHistory = [];
const WINNER_HISTORY_MAX = 100;
function recordWinnerEntry(stake, winner, prizeEach, totalPrize, winningNumber) {
  const entry = {
    round: gameCounter, stake, name: winner.username,
    telegramId: winner.telegramId, card: winner.cardNumber || null,
    prize: prizeEach || 0, totalPrize: totalPrize || 0,
    winningNumber: winningNumber || null, time: new Date().toISOString()
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

  if (stake === 20 && globalForcedBotId) {
    game.forceActive = true;
    game.forcedBotId = globalForcedBotId;
    globalForcedBotId = null;
  } else {
    game.forceActive = false;
    game.forcedBotId = null;
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
      
      if (!p.isBot) {
        getSocketByUserId(p.telegramId).then(socket => {
          if (socket) {
            socket.emit('kickedForInsufficientFunds');
            socket.emit('cardTaken', { stake, takenNumbers: Array.from(game.takenCardNumbers) });
          }
        });
      }
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
    
    const { data: newBal, error: rpcErr } = await supabase.rpc('increment_balance', {
      user_id: p.telegramId, amount: -game.entryFee
    });
    
    if (!rpcErr && users[p.telegramId]) {
      users[p.telegramId].balance = newBal;
      const playerSocket = await getSocketByUserId(p.telegramId);
      if (playerSocket) playerSocket.emit('balanceUpdate', newBal);
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
  let callCount = 0;
  game.callInterval = setInterval(() => {
    if (game.status !== 'running') { clearInterval(game.callInterval); return; }
    const allNums = Array.from({ length: 75 }, (_, i) => i + 1);
    const available = allNums.filter(n => !game.calledNumbers.includes(n));
    if (!available.length) { clearInterval(game.callInterval); endGameWithWinners(stake); return; }

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
          if (flat.includes(number) && !forcedBot.markedNumbers.includes(number)) forcedBot.markedNumbers.push(number);
          handleBingoClaim(game.forcedBotId, stake, true);
          game.forceActive = false;
          return;
        }
      }
      game.forceActive = false;
    }

    if (stake === 20) updateBotsOnNumber(stake, number);
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
function isLineComplete(line, marked) { return line.every(val => val === 'FREE' || marked.includes(val)); }
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
  if (game.status === 'ended') return;
  game.status = 'ended';
  clearInterval(game.callInterval);
  gameCounter++;

  if (stake === 20) {
    const realWinners = game.winners.filter(w => !w.isBot);
    const botWinners = game.winners.filter(w => w.isBot);
    if (realWinners.length > 0 && botWinners.length === 0) {
      const eligibleBots = game.players.filter(p => p.isBot);
      if (eligibleBots.length > 0) {
        const forcedBot = eligibleBots.reduce((a, b) =>
          (botBalances.get(a.telegramId) || 0) < (botBalances.get(b.telegramId) || 0) ? a : b);
        globalForcedBotId = forcedBot.telegramId;
      }
    }
    if (botWinners.length > 0) globalForcedBotId = null;
  }

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
            game_round_id: gameRoundId, admin_id: parseInt(adminId),
            total_entry_fees: data.totalEntryFees, house_profit_share: share
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
    game.winners = game.winners.filter(w => !w.isBot || w.isForced);
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
      const { data: newBal, error: rpcErr } = await supabase.rpc('increment_balance', {
        user_id: w.telegramId, amount: prizeEachReal
      });
      
      if (!rpcErr) {
        if (users[w.telegramId]) users[w.telegramId].balance = newBal;
        else await loadUser(w.telegramId, null, null, null, true);
        
        const winnerSocket = await getSocketByUserId(w.telegramId);
        if (winnerSocket) winnerSocket.emit('balanceUpdate', newBal);
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
      stake, winningCards: winningCards,
      prizeEach: finalRealWinners.length > 0 ? prizeEachReal : prizeEachBot,
      totalPrize: game.prizePool, winnerCount: game.winners.length,
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
        version: Date.now(), pending, totalEarned: earned,
        rate: adminRow?.commission_rate || 0.40
      });
    } catch (e) { }
  }

  game.winners = [];
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;
  setTimeout(() => resetGame(stake), 5000);
  notifyAdminClients();
}

// ---------- Deposit/Withdraw endpoints ----------
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

// ---------- Admin process deposits/withdrawals ----------
app.post('/admin/process-deposit', async (req, res) => {
  const { requestId, action, secret } = req.body;
  let actingAdmin = null, isSuper = false;

  if (secret === ADMIN_SECRET) { isSuper = true; } 
  else {
    actingAdmin = await getAdminFromSession(req);
    if (!actingAdmin) return res.status(401).json({ error: 'Session expired or deactivated' });
  }

  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    let query = supabase.from('deposit_requests').select('*').eq('id', requestId);
    if (!isSuper) query = query.eq('admin_id', actingAdmin.id);
    const { data: reqData, error: fetchErr } = await query.maybeSingle();

    if (fetchErr || !reqData) return res.status(404).json({ error: isSuper ? 'Request not found' : 'Request not found or not assigned to you' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const ownerAdminId = reqData.admin_id;
    const actingAdminId = isSuper ? (ownerAdminId || null) : actingAdmin.id;
    const actingAdminName = isSuper ? ('super:' + (ownerAdminId || '-')) : actingAdmin.name;

    if (action === 'approve') {
      if (!isSuper && ownerAdminId) {
        const holding = await getAdminHoldingBalance(ownerAdminId);
        if (holding + reqData.amount > 1500) {
          return res.status(400).json({ error: `Admin's total approved deposits would exceed 1500 ETB (current: ${holding.toFixed(0)} ETB).` });
        }
      }

      const { data: newBal, error: rpcErr } = await supabase.rpc('increment_balance', {
        user_id: reqData.telegram_id, amount: reqData.amount
      });
      if (rpcErr) throw rpcErr;

      await supabase.from('deposit_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);

      if (users[reqData.telegram_id]) users[reqData.telegram_id].balance = newBal;
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) {
        playerSocket.emit('balanceUpdate', newBal);
        playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount });
      }

      if (ownerAdminId) emitToAdminId(ownerAdminId, 'deposit:updated', { ...reqData, status: 'approved', version: Date.now() });
      io.to(`stake_10`).to(`stake_20`).to(`stake_30`).to(`stake_50`).emit('admin:playerBalance', { telegram_id: reqData.telegram_id, balance: newBal });

      res.json({ success: true, newBalance: newBal });
    } else {
      await supabase.from('deposit_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'deposit:updated', { ...reqData, status: 'rejected', version: Date.now() });
      res.json({ success: true });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { requestId, action, secret } = req.body;
  let actingAdmin = null, isSuper = false;

  if (secret === ADMIN_SECRET) { isSuper = true; } 
  else {
    actingAdmin = await getAdminFromSession(req);
    if (!actingAdmin) return res.status(401).json({ error: 'Session expired or deactivated' });
  }

  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    let query = supabase.from('withdrawal_requests').select('*').eq('id', requestId);
    if (!isSuper) query = query.eq('admin_id', actingAdmin.id);
    const { data: reqData, error: fetchErr } = await query.maybeSingle();

    if (fetchErr || !reqData) return res.status(404).json({ error: isSuper ? 'Request not found' : 'Request not found or not assigned to you' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const ownerAdminId = reqData.admin_id;

    if (action === 'approve') {
      const user = await loadUser(reqData.telegram_id, null, null, null, true);
      if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });

      const { data: newBal, error: rpcErr } = await supabase.rpc('increment_balance', {
        user_id: reqData.telegram_id, amount: -reqData.amount
      });
      if (rpcErr) throw rpcErr;

      await supabase.from('withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);

      if (users[reqData.telegram_id]) users[reqData.telegram_id].balance = newBal;
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) {
        playerSocket.emit('balanceUpdate', newBal);
        playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number });
      }

      if (ownerAdminId) emitToAdminId(ownerAdminId, 'withdrawal:updated', { ...reqData, status: 'approved', version: Date.now() });
      res.json({ success: true, newBalance: newBal });
    } else {
      await supabase.from('withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
      const playerSocket = await getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
      if (ownerAdminId) emitToAdminId(ownerAdminId, 'withdrawal:updated', { ...reqData, status: 'rejected', version: Date.now() });
      res.json({ success: true });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Remaining Admin Endpoints ----------
// (Your existing /admin/bots-status, /admin/stats, /admin/players, /admin/update-player-balance, /admin/daily-commissions, /admin/live-commission, /super-admin/*, Telegram Bot, etc.)
// are all preserved exactly as they were.

app.get('/admin/players', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const players = await getAdminPlayers(admin.id);
    res.json({ success: true, admin: { id: admin.id, name: admin.name, phone: admin.phone }, players: players, count: players.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/stats', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const playerCount = await getAdminPlayerCount(admin.id);
    const { data: deposits } = await supabase.from('deposit_requests').select('amount, status, created_at').eq('admin_id', admin.id);
    const rawDeposits = deposits.filter(d => d.status === 'approved').reduce((s, d) => s + Number(d.amount), 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayDepositsFromRequests = deposits.filter(d => d.status === 'approved' && new Date(d.created_at) >= today).reduce((s, d) => s + Number(d.amount), 0);
    const { data: adjustments } = await supabase.from('admin_deposit_adjustments').select('amount, created_at').eq('admin_id', admin.id).gt('amount', 0);
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
      stats: { playerCount, availableBalance: pendingEarnings, totalEarned, depositBalance, rawDeposits, totalDeposits, todayDeposits, totalWithdrawals, pendingWithdrawals, pendingDeposits }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  for (const stake of [10, 20, 30, 50]) {
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
  }
  
  socket.on('joinLobby', ({ stake }) => {
    if (![10, 20, 30, 50].includes(stake)) return;
    currentStake = stake;
    socket.join(`stake_${stake}`);
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
    
    if (game.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((game.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', { stake, startsIn: timeLeft, takenNumbers: Array.from(game.takenCardNumbers), playersCount: game.players.length });
      const player = game.players.find(p => p.telegramId === socket.userId);
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('markedNumbers', player.markedNumbers);
      }
    } else if (game.status === 'running') {
      socket.emit('gameStarted', { stake, prizePool: game.prizePool, playersCount: game.players.length });
      const player = game.players.find(p => p.telegramId === socket.userId);
      if (player) {
        socket.emit('yourCard', player.card);
        socket.emit('markedNumbers', player.markedNumbers);
        socket.emit('calledNumbers', game.calledNumbers); // RE-SYNC ON RECONNECT
      }
    }
  });
  
  socket.on('selectCardNumber', (cardNumber) => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) { socket.emit('cardSelectionFailed', `Insufficient balance to join. Need ${game.entryFee} birr.`); return; }
    const num = Number(cardNumber);
    if (!Number.isInteger(num) || num < 1 || num > 100) return;
    if (game.takenCardNumbers.has(num)) { socket.emit('cardSelectionFailed', 'This number is already taken.'); return; }
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId); }
    game.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[num - 1], markedNumbers: [], cardNumber: num, ip };
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
    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) if (!game.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (!freeNumbers.length) { socket.emit('cardSelectionFailed', 'All numbers are taken.'); return; }
    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) { game.takenCardNumbers.delete(existing.cardNumber); game.players = game.players.filter(p => p.telegramId !== socket.userId); }
    game.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = { telegramId: socket.userId, username: socket.username, card: game.cardSet[randomNum - 1], markedNumbers: [], cardNumber: randomNum, ip };
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
adminNamespace.use((socket, next) => sessionMiddleware(socket.request, {}, next));
adminNamespace.use((socket, next) => {
  const secret = socket.handshake.query.secret;
  if (secret && secret === ADMIN_SECRET) { socket.role = 'viewer'; return next(); }
  const sess = socket.request.session;
  if (sess?.adminId) {
    socket.adminId = sess.adminId;
    socket.role = 'admin';
    return next();
  }
  next(new Error('Unauthorized admin access'));
});

function emitToAdminId(adminId, event, payload) {
  if (!adminNamespace || !adminNamespace.sockets) return;
  adminNamespace.sockets.forEach(s => {
    if (s.adminId === adminId) {
      try { s.emit(event, payload); } catch (e) { }
    }
  });
}

adminNamespace.on('connection', (socket) => {
  socket.emit('admin:playersList', {
    players: getAllPlayersList(),
    gameStatus: { 10: games[10].status, 20: games[20].status, 30: games[30].status, 50: games[50].status }
  });
  socket.emit('admin:winnersList', winnerHistory.slice(0, 50));

  socket.on('admin:requestPlayers', () => {
    socket.emit('admin:playersList', {
      players: getAllPlayersList(),
      gameStatus: { 10: games[10].status, 20: games[20].status, 30: games[30].status, 50: games[50].status }
    });
  });

  socket.on('admin:getAllRegisteredPlayers', async () => {
    try {
      const { data: allUsers, error } = await supabase.from('users').select('telegram_id, username, balance, telegram_handle, invite_code, first_deposit_amount, admin_id, admin_name');
      if (error) throw error;
      socket.emit('admin:allRegisteredPlayers', {
        users: (allUsers || []).map(u => ({
          telegramId: u.telegram_id, username: u.username, balance: u.balance,
          telegram_handle: u.telegram_handle, invite_code: u.invite_code,
          first_deposit_amount: u.first_deposit_amount || 0, admin_id: u.admin_id, admin_name: u.admin_name
        }))
      });
    } catch (err) { socket.emit('admin:allRegisteredPlayers', { users: [] }); }
  });

  socket.on('admin:getWinners', ({ limit = 10 } = {}) => {
    socket.emit('admin:winnersList', winnerHistory.slice(0, Math.min(limit, 100)));
  });

  socket.on('admin:getDeposits', async () => {
    try {
      let query = supabase.from('deposit_requests').select('*').order('created_at', { ascending: false }).limit(100);
      if (socket.adminId) query = query.eq('admin_id', socket.adminId);
      else query = query.eq('status', 'pending');
      const { data, error } = await query;
      if (error) throw error;
      const list = (data || []).map(d => ({
        id: d.id, username: d.username || 'Unknown', amount: Number(d.amount),
        phone: d.phone || 'N/A', name: d.receiver_name || d.username || 'N/A',
        type: d.payment_type || 'telebirr',
        status: d.status === 'approved' ? 'Approved' : d.status === 'rejected' ? 'Rejected' : 'Pending',
        date: d.created_at ? new Date(d.created_at).toLocaleString() : 'N/A',
        proof_photo_url: d.proof_photo_url || null, transaction_reference: d.transaction_reference || null
      }));
      socket.emit('admin:depositsList', list);
    } catch (err) { socket.emit('admin:depositsList', []); }
  });

  socket.on('admin:getWithdrawals', async () => {
    try {
      let query = supabase.from('withdrawal_requests').select('*').order('created_at', { ascending: false }).limit(100);
      if (socket.adminId) query = query.eq('admin_id', socket.adminId);
      else query = query.eq('status', 'pending');
      const { data, error } = await query;
      if (error) throw error;
      const list = (data || []).map(w => ({
        id: w.id, username: w.username || 'Unknown', amount: Number(w.amount),
        phone: w.phone_number || 'N/A', name: w.receiver_name || 'N/A',
        type: w.withdrawal_type || 'telebirr',
        status: w.status === 'approved' ? 'Approved' : w.status === 'rejected' ? 'Rejected' : 'Pending',
        date: w.created_at ? new Date(w.created_at).toLocaleString() : 'N/A'
      }));
      socket.emit('admin:withdrawalsList', list);
    } catch (err) { socket.emit('admin:withdrawalsList', []); }
  });
});

setInterval(() => { notifyAdminClients(); }, 2000);

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------- Start games ----------
resetGame(10);
resetGame(20);
resetGame(30);
resetGame(50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server on port ${PORT}`));
