// ================================================================
//  server.js – Full Bingo Server
//             with invite tracking, screenshot deposits,
//             winning card numbers, background write queue,
//             crash recovery snapshots, idempotency, and
//             WebSocket-only transport.
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
    if (listError) {
      console.error('❌ Failed to list buckets:', listError.message);
      return;
    }
    const exists = buckets.some(b => b.name === bucketName);
    if (!exists) {
      console.log(`📦 Creating storage bucket "${bucketName}"...`);
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
        file_size_limit: 5242880,
        allowed_mime_types: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']
      });
      if (createError) {
        console.error('❌ Failed to create bucket:', createError.message);
      } else {
        console.log(`✅ Bucket "${bucketName}" created successfully.`);
        const { error: policyError } = await supabase.storage
          .from(bucketName)
          .update({ public: true });
        if (policyError) {
          console.error('❌ Failed to set bucket public:', policyError.message);
        }
      }
    } else {
      console.log(`✅ Bucket "${bucketName}" already exists.`);
    }
  } catch (err) {
    console.error('❌ Error ensuring bucket:', err.message);
  }
}
ensureDepositBucket();

// ================================================================
//  WRITE QUEUE  — non-critical writes go here
// ================================================================
class WriteQueue {
  constructor(supabase, flushIntervalMs = 2000, batchSize = 50) {
    this.supabase = supabase;
    this.queue = [];
    this.flushIntervalMs = flushIntervalMs;
    this.batchSize = batchSize;
    this.isFlushing = false;
    this.stats = { processed: 0, failed: 0, deadLettered: 0 };
    setInterval(() => this.flush(), flushIntervalMs).unref();
  }

  push(type, payload) {
    this.queue.push({
      type,
      payload,
      attempts: 0,
      enqueuedAt: Date.now()
    });
    if (this.queue.length >= this.batchSize) {
      setImmediate(() => this.flush());
    }
  }

  async flush() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;

    const batch = this.queue.splice(0, this.batchSize);

    const grouped = {};
    for (const item of batch) {
      if (!grouped[item.type]) grouped[item.type] = [];
      grouped[item.type].push(item);
    }

    const retryable = [];

    await Promise.all(
      Object.entries(grouped).map(async ([type, items]) => {
        try {
          const rows = items.map(i => i.payload);
          let error = null;

          if (type === 'game_round') {
            ({ error } = await this.supabase.from('game_rounds').insert(rows));
          } else if (type === 'admin_contribution') {
            ({ error } = await this.supabase.from('game_admin_contributions').insert(rows));
          } else if (type === 'audit_log') {
            ({ error } = await this.supabase.from('audit_logs').insert(rows));
          } else if (type === 'round_winner') {
            // ★ NEW ★ optional durable storage (create table round_winners)
            ({ error } = await this.supabase.from('round_winners').insert(rows));
          } else {
            console.warn(`[WriteQueue] Unknown type: ${type}`);
            return;
          }

          if (error) throw new Error(error.message);
          this.stats.processed += items.length;
        } catch (err) {
          for (const item of items) {
            item.attempts++;
            if (item.attempts < 4) {
              retryable.push(item);
            } else {
              this.stats.deadLettered++;
              try {
                await this.supabase.from('write_queue_failures').insert({
                  queue_type: item.type,
                  payload: item.payload,
                  error: err.message,
                  attempts: item.attempts
                });
              } catch (e) {
                console.error('[WriteQueue] Failed to dead-letter:', e.message);
              }
            }
          }
          this.stats.failed += items.length;
          console.error(`[WriteQueue] Batch failed (${type}):`, err.message);
        }
      })
    );

    this.queue.push(...retryable);
    this.isFlushing = false;

    if (this.queue.length > 500) {
      console.warn(`[WriteQueue] WARNING: queue size = ${this.queue.length}`);
    }
  }

  size() { return this.queue.length; }
}

const writeQueue = new WriteQueue(supabase);

// ================================================================
//  SOCKET MAP  — O(1) lookup
// ================================================================
const socketByUser = new Map();

function getSocketByUserId(userId) {
  return socketByUser.get(String(userId));
}

// ================================================================
//  EXPRESS + SOCKET.IO SETUP
// ================================================================
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout: 20000,
  perMessageDeflate: false
});

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'), false);
  }
});

app.use(express.json({ limit: '10mb' }));

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

// ================================================================
//  AUDIT LOGGER  — now enqueues to writeQueue
// ================================================================
function logAuditEvent({ eventType, roomId = null, userId = 'system', ipAddress = null, details = {} }) {
  writeQueue.push('audit_log', {
    event_type: eventType,
    room_id: roomId,
    user_id: userId,
    ip_address: ipAddress,
    details
  });
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
      reason: `More than ${MAX_WINS_IN_WINDOW} wins in ${WINDOW_MS / 1000}s`,
      evidence: { recentWinCount: recent.length, windowMs: WINDOW_MS }
    });
    return true;
  }
  return false;
}

// ---------- Admin helper functions ----------
const adminCache = {};
async function loadAdmin(secretKey) {
  if (adminCache[secretKey] && (Date.now() - adminCache[secretKey].cachedAt < 60000)) return adminCache[secretKey];
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('*')
      .eq('secret_key', secretKey)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (data) { adminCache[secretKey] = { ...data, cachedAt: Date.now() }; return adminCache[secretKey]; }
    return null;
  } catch (err) { console.error('Error loading admin:', err.message); return null; }
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
  } catch (err) { console.error('Error fetching admins:', err.message); return []; }
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
  } catch (err) { console.error('Error fetching admin players:', err.message); return []; }
}

async function getAdminPlayerCount(adminId) {
  try {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('admin_id', adminId);
    if (error) throw error;
    return count || 0;
  } catch (err) { console.error('Error counting admin players:', err.message); return 0; }
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
  } catch (err) { console.error('Error fetching admin deposits:', err.message); return 0; }
}

async function getAdminHoldingBalance(adminId) {
  const { data: deposits, error: depErr } = await supabase
    .from('deposit_requests')
    .select('amount')
    .eq('admin_id', adminId)
    .eq('status', 'approved');
  if (depErr) throw depErr;
  const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);

  const { data: adjustments, error: adjErr } = await supabase
    .from('admin_deposit_adjustments')
    .select('amount')
    .eq('admin_id', adminId);
  if (adjErr) throw adjErr;
  const totalAdjustments = adjustments.reduce((sum, a) => sum + Number(a.amount), 0);

  return totalDeposits + totalAdjustments;
}

async function getAdminEarnings(adminId) {
  const { data: contributions, error: contribErr } = await supabase
    .from('game_admin_contributions')
    .select('house_profit_share, created_at')
    .eq('admin_id', adminId);

  if (contribErr) {
    console.error('Error fetching contributions:', contribErr.message);
    return { pending: 0, earned: 0 };
  }

  const { data: paidCommissions, error: paidErr } = await supabase
    .from('admin_daily_commissions')
    .select('commission_amount, date')
    .eq('admin_id', adminId)
    .eq('status', 'paid');

  if (paidErr) {
    console.error('Error fetching paid commissions:', paidErr.message);
    return { pending: 0, earned: 0 };
  }

  const paidDates = new Set();
  if (paidCommissions) {
    paidCommissions.forEach(c => paidDates.add(c.date));
  }

  let pending = 0;
  if (contributions) {
    for (const contrib of contributions) {
      const date = new Date(contrib.created_at);
      const dateStr = date.toISOString().split('T')[0];
      if (!paidDates.has(dateStr)) {
        pending += Number(contrib.house_profit_share) || 0;
      }
    }
  }

  const earned = paidCommissions ? paidCommissions.reduce((sum, c) => sum + Number(c.commission_amount), 0) : 0;

  return { pending, earned };
}

async function markContributionsAsPaid(adminId, amount, paidAt = new Date().toISOString()) {
  const { data: paidCommissions, error: paidErr } = await supabase
    .from('admin_daily_commissions')
    .select('date')
    .eq('admin_id', adminId)
    .eq('status', 'paid');
  if (paidErr) throw paidErr;
  const paidDates = new Set(paidCommissions.map(d => d.date));

  const { data: contributions, error: contribErr } = await supabase
    .from('game_admin_contributions')
    .select('created_at, house_profit_share')
    .eq('admin_id', adminId)
    .order('created_at', { ascending: true });
  if (contribErr) throw contribErr;

  const grouped = {};
  for (const c of contributions) {
    const date = new Date(c.created_at).toISOString().split('T')[0];
    if (!paidDates.has(date)) {
      if (!grouped[date]) grouped[date] = 0;
      grouped[date] += Number(c.house_profit_share) || 0;
    }
  }

  let remaining = amount;
  const sortedDates = Object.keys(grouped).sort();

  for (const date of sortedDates) {
    if (remaining <= 0) break;
    const available = grouped[date];
    const toPay = Math.min(available, remaining);

    const { data: existing, error: existErr } = await supabase
      .from('admin_daily_commissions')
      .select('id')
      .eq('admin_id', adminId)
      .eq('date', date)
      .maybeSingle();
    if (existErr) throw existErr;

    if (existing) {
      const { error: updateErr } = await supabase
        .from('admin_daily_commissions')
        .update({ status: 'paid', paid_at: paidAt })
        .eq('id', existing.id);
      if (updateErr) throw updateErr;
    } else {
      const newEntry = {
        admin_id: adminId,
        date,
        total_entry_fees: 0,
        total_house_profit: grouped[date],
        commission_amount: grouped[date],
        status: 'paid',
        paid_at: paidAt
      };
      const { error: insertErr } = await supabase
        .from('admin_daily_commissions')
        .insert(newEntry);
      if (insertErr) throw insertErr;
    }

    remaining -= toPay;
  }

  if (remaining > 0) {
    throw new Error(`Insufficient pending earnings: only ${amount - remaining} of ${amount} was covered`);
  }

  return true;
}

async function isSuperAdmin(adminId) {
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('is_super_admin')
      .eq('id', adminId)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return false;
    return data.is_super_admin === true;
  } catch { return false; }
}

async function getAdminFromSession(req) {
  if (!req.session.adminId) return null;
  const { data, error } = await supabase
    .from('admins')
    .select('*')
    .eq('id', req.session.adminId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    req.session.destroy();
    return null;
  }
  return data;
}

// ================================================================
//  TRANSACTION NUMBER EXTRACTOR
// ================================================================
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
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1].toUpperCase();
  }

  if (/^[A-Za-z0-9]{8,16}$/.test(trimmed)) return trimmed.toUpperCase();

  const fallback = trimmed.match(/\b([A-Za-z0-9]{8,16})\b/);
  if (fallback) return fallback[1].toUpperCase();

  return null;
}

// ================================================================
//  STATIC ENDPOINTS
// ================================================================
app.get('/api/deposit-accounts', async (req, res) => {
  try {
    const userId = req.session?.userId;
    let adminId = null;

    if (userId) {
      const { data: user, error } = await supabase
        .from('users')
        .select('admin_id')
        .eq('telegram_id', userId)
        .maybeSingle();
      if (!error && user) adminId = user.admin_id;
    }

    let admins = [];
    if (adminId) {
      const { data: admin, error } = await supabase
        .from('admins')
        .select('id, name, telebirr_number, cbebirr_number, mpesa_number, accept_deposits')
        .eq('id', adminId)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      if (admin && admin.accept_deposits !== false) admins = [admin];
    } else {
      const { data: allAdmins, error: allErr } = await supabase
        .from('admins')
        .select('id, name, telebirr_number, cbebirr_number, mpesa_number, accept_deposits')
        .eq('is_active', true);
      if (allErr) throw allErr;
      admins = allAdmins.filter(a => a.accept_deposits !== false);
    }

    const result = admins.map(a => ({
      id: a.id,
      name: a.name,
      telebirr: a.telebirr_number || null,
      cbebirr: a.cbebirr_number || null,
      mpesa: a.mpesa_number || null
    }));

    res.json({ success: true, admins: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin-phone', (req, res) => res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'live.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/users', (req, res) => res.sendFile(path.join(__dirname, 'users.html')));
app.get('/invite-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-dashboard.html')));
app.get('/bots', (req, res) => res.sendFile(path.join(__dirname, 'bots.html')));
app.get('/admin-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));
app.get('/admin-auth', (req, res) => res.sendFile(path.join(__dirname, 'admin-auth.html')));
app.get('/super-admin', (req, res) => res.sendFile(path.join(__dirname, 'super-admin.html')));
app.get('/welcome', (req, res) => res.sendFile(path.join(__dirname, 'welcome.html')));
app.get('/invite-tracking-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-tracking-dashboard.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/admin-bots', (req, res) => res.sendFile(path.join(__dirname, 'admin-bots.html')));
app.get('/admin-bot-stats', (req, res) => res.sendFile(path.join(__dirname, 'admin-bot-stats.html')));

app.get('/admin/live-players', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'admin-live-players.html'));
});

// ================================================================
//  USER CACHE + LOAD USER (with 30s TTL)
// ================================================================
const users = {};
const USER_CACHE_TTL_MS = 30_000;

async function loadUser(telegramId, username, telegramHandle = null, inviteCode = null, refresh = false, adminId = null) {
  const id = String(telegramId);

  if (!refresh && users[id]) {
    const age = Date.now() - (users[id]._lastFetch || 0);
    if (age < USER_CACHE_TTL_MS) return users[id];
  }

  try {
    let { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', id)
      .maybeSingle();
    if (error) throw error;

    if (data) {
      let needUpdate = false;
      if (!data.invite_code || !data.admin_id) {
        const { data: inviteTrack } = await supabase
          .from('invite_tracking')
          .select('invite_code, admin_id, admin_name')
          .eq('telegram_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (inviteTrack) {
          if (!data.invite_code && inviteTrack.invite_code) {
            data.invite_code = inviteTrack.invite_code;
            needUpdate = true;
          }
          if (!data.admin_id && inviteTrack.admin_id) {
            data.admin_id = inviteTrack.admin_id;
            data.admin_name = inviteTrack.admin_name || null;
            needUpdate = true;
          }
        }
      }

      if (inviteCode && !data.invite_code) {
        data.invite_code = inviteCode;
        needUpdate = true;
      }

      if (!data.admin_id && data.invite_code) {
        const { data: admin } = await supabase
          .from('admins')
          .select('id, name')
          .eq('invite_code', data.invite_code)
          .eq('is_active', true)
          .maybeSingle();
        if (admin) {
          data.admin_id = admin.id;
          data.admin_name = admin.name;
          needUpdate = true;
        }
      }

      if (needUpdate) {
        await supabase
          .from('users')
          .update({
            invite_code: data.invite_code,
            admin_id: data.admin_id,
            admin_name: data.admin_name
          })
          .eq('telegram_id', id);
      }

      users[id] = {
        id,
        username: data.username,
        balance: Number(data.balance),
        telegram_handle: data.telegram_handle,
        invite_code: data.invite_code,
        first_deposit_amount: data.first_deposit_amount || 0,
        admin_id: data.admin_id,
        admin_name: data.admin_name,
        _lastFetch: Date.now()
      };
      return users[id];
    } else {
      let finalInviteCode = inviteCode || null;
      let finalAdminId = adminId || null;
      let finalAdminName = null;

      if (!finalInviteCode || !finalAdminId) {
        const { data: inviteTrack } = await supabase
          .from('invite_tracking')
          .select('invite_code, admin_id, admin_name')
          .eq('telegram_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (inviteTrack) {
          if (!finalInviteCode) finalInviteCode = inviteTrack.invite_code;
          if (!finalAdminId) {
            finalAdminId = inviteTrack.admin_id;
            finalAdminName = inviteTrack.admin_name;
          }
        }
      }

      if (!finalAdminId && finalInviteCode) {
        const { data: admin } = await supabase
          .from('admins')
          .select('id, name')
          .eq('invite_code', finalInviteCode)
          .eq('is_active', true)
          .maybeSingle();
        if (admin) {
          finalAdminId = admin.id;
          finalAdminName = admin.name;
        }
      }

      if (!finalInviteCode) {
        throw new Error('Invite required. Please use an invite link from an admin to create an account.');
      }

      const newUser = {
        telegram_id: id,
        username: username || 'Player',
        telegram_handle: telegramHandle || null,
        balance: 10,
        invite_code: finalInviteCode,
        first_deposit_amount: 0,
        admin_id: finalAdminId,
        admin_name: finalAdminName
      };

      const { error: insertError } = await supabase.from('users').insert(newUser);
      if (insertError) throw insertError;

      if (finalInviteCode && finalAdminId) {
        const { data: existingTrack } = await supabase
          .from('invite_tracking')
          .select('id')
          .eq('telegram_id', id)
          .eq('invite_code', finalInviteCode)
          .maybeSingle();
        if (!existingTrack) {
          await supabase
            .from('invite_tracking')
            .insert({
              telegram_id: id,
              username: username || 'Player',
              invite_code: finalInviteCode,
              admin_id: finalAdminId,
              admin_name: finalAdminName,
              ip_address: null,
              user_agent: null
            });
        }
      }

      users[id] = {
        id,
        username: newUser.username,
        balance: 10,
        telegram_handle: newUser.telegram_handle,
        invite_code: newUser.invite_code,
        first_deposit_amount: 0,
        admin_id: newUser.admin_id,
        admin_name: newUser.admin_name,
        _lastFetch: Date.now()
      };
      return users[id];
    }
  } catch (err) {
    console.error(`❌ loadUser error for ${id}:`, err.message);
    throw err;
  }
}

// ================================================================
//  TELEGRAM AUTH
// ================================================================
function verifyTelegram(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return calculatedHash === hash;
  } catch (err) {
    console.error('❌ Verification error:', err.message);
    return false;
  }
}

app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) {
    return res.status(403).json({ success: false, error: 'Invalid initData' });
  }
  try {
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get('user'));
    const startParam = params.get('start_param');
    const id = String(userData.id);
    const displayName = userData.first_name || userData.username || 'Player';
    const handle = userData.username || null;

    const user = await loadUser(id, displayName, handle, startParam, !!startParam);
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
        admin_name: user.admin_name,
        invite_code: user.invite_code
      });
    });
  } catch (err) {
    if (err.message === 'Invite required. Please use an invite link from an admin to create an account.') {
      return res.status(403).json({ success: false, error: 'Invite required. Please use an invite link from an admin.' });
    }
    console.error('❌ Auth error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
//  ADMIN LOGIN / REGISTER / SESSION
// ================================================================
app.post('/admin/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ success: false, error: 'Phone and PIN required' });
  try {
    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('phone', phone)
      .eq('pin', pin)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !admin) return res.status(401).json({ success: false, error: 'Invalid phone or PIN' });
    req.session.adminId = admin.id;
    req.session.adminName = admin.name;
    req.session.adminPhone = admin.phone;
    req.session.adminSecret = admin.secret_key;
    res.json({ success: true, admin: { id: admin.id, name: admin.name, phone: admin.phone, deposit_number: admin.deposit_number } });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/register', async (req, res) => {
  const {
    phone, name, deposit_number, payment_type, pin, confirm_pin,
    registration_secret, telebirr_number, cbebirr_number, mpesa_number
  } = req.body;
  if (!phone || !name || !pin || !confirm_pin) {
    return res.status(400).json({ success: false, error: 'Phone, name, and PIN are required' });
  }
  if (pin !== confirm_pin) return res.status(400).json({ success: false, error: 'PINs do not match' });
  if (pin.length < 4 || !/^\d+$/.test(pin)) return res.status(400).json({ success: false, error: 'PIN must be at least 4 digits' });
  if (!phone.match(/^(09|07)\d{8}$/)) return res.status(400).json({ success: false, error: 'Invalid phone number' });
  if (payment_type && !['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) {
    return res.status(400).json({ success: false, error: 'Invalid payment type' });
  }
  const requiredSecret = process.env.ADMIN_REGISTRATION_SECRET;
  if (requiredSecret && registration_secret !== requiredSecret) {
    return res.status(403).json({ success: false, error: 'Invalid registration secret' });
  }
  try {
    const { data: existing } = await supabase
      .from('admins')
      .select('phone')
      .eq('phone', phone)
      .maybeSingle();
    if (existing) return res.status(400).json({ success: false, error: 'Phone number already registered' });
    const secretKey = crypto.randomBytes(16).toString('hex');
    const inviteCode = name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const { data: newAdmin, error: insertErr } = await supabase
      .from('admins')
      .insert({
        phone, name,
        deposit_number: deposit_number || null,
        payment_type: payment_type || null,
        secret_key: secretKey,
        pin,
        invite_code: inviteCode,
        commission_rate: 0.40,
        is_active: true,
        telebirr_number: telebirr_number || null,
        cbebirr_number: cbebirr_number || null,
        mpesa_number: mpesa_number || null,
        accept_deposits: true
      })
      .select()
      .single();
    if (insertErr) throw insertErr;
    res.json({
      success: true,
      message: 'Registration successful!',
      admin: { id: newAdmin.id, name: newAdmin.name, phone: newAdmin.phone, deposit_number: newAdmin.deposit_number }
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/admin/session', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) {
    req.session.destroy();
    return res.status(401).json({ success: false, error: 'Session expired or deactivated' });
  }
  res.json({
    success: true,
    admin: {
      id: admin.id,
      name: admin.name,
      phone: admin.phone,
      deposit_number: admin.deposit_number,
      commission_rate: admin.commission_rate,
      invite_code: admin.invite_code,
      telebirr_number: admin.telebirr_number,
      cbebirr_number: admin.cbebirr_number,
      mpesa_number: admin.mpesa_number
    }
  });
});

app.get('/admin/registration-config', (req, res) => {
  const requiresSecret = !!process.env.ADMIN_REGISTRATION_SECRET;
  res.json({ requiresSecret });
});

app.get('/admin/invite-info', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) {
    req.session.destroy();
    return res.status(401).json({ error: 'Session expired or deactivated' });
  }
  try {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'bingomkmk0120_bot';
    const inviteLink = `https://t.me/${botUsername}?start=${admin.invite_code}`;
    res.json({
      success: true,
      admin: {
        id: admin.id, name: admin.name,
        invite_code: admin.invite_code,
        invite_link: inviteLink,
        phone: admin.phone,
        deposit_number: admin.deposit_number
      }
    });
  } catch (err) {
    console.error('Error fetching invite info:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/invite-code', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ success: false, error: 'Not logged in' });

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('invite_code, admin_id, admin_name')
      .eq('telegram_id', String(userId))
      .maybeSingle();

    if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });

    const { data: inviteTrack } = await supabase
      .from('invite_tracking')
      .select('*')
      .eq('telegram_id', String(userId))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let adminInfo = null;
    if (user.admin_id) {
      const { data: admin } = await supabase
        .from('admins')
        .select('name, invite_code')
        .eq('id', user.admin_id)
        .maybeSingle();
      if (admin) adminInfo = admin;
    }

    res.json({
      success: true,
      invite_code: user.invite_code,
      admin_id: user.admin_id,
      admin_name: user.admin_name,
      admin: adminInfo,
      invite_tracking: inviteTrack || null
    });
  } catch (err) {
    console.error('Error fetching invite code:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/invite-tracking', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) {
    req.session.destroy();
    return res.status(401).json({ error: 'Session expired or deactivated' });
  }

  try {
    const { from, to, limit = 100 } = req.query;

    let query = supabase
      .from('invite_tracking')
      .select('*')
      .eq('admin_id', admin.id)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 1000));

    if (from) {
      const fromDate = new Date(from);
      fromDate.setHours(0, 0, 0, 0);
      query = query.gte('created_at', fromDate.toISOString());
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      query = query.lte('created_at', toDate.toISOString());
    }

    const { data: invites, error } = await query;
    if (error) throw error;

    const { data: allInvites, error: statsErr } = await supabase
      .from('invite_tracking')
      .select('telegram_id, created_at')
      .eq('admin_id', admin.id);

    if (statsErr) throw statsErr;

    const totalInvites = allInvites.length;
    const uniqueUsers = new Set(allInvites.map(i => i.telegram_id)).size;

    const dailyStats = {};
    allInvites.forEach(invite => {
      const date = new Date(invite.created_at).toISOString().split('T')[0];
      if (!dailyStats[date]) dailyStats[date] = 0;
      dailyStats[date]++;
    });

    res.json({
      success: true,
      stats: { totalInvites, uniqueUsers, dailyStats },
      invites
    });
  } catch (err) {
    console.error('Error fetching invite tracking:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/update-invite-code', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) {
    req.session.destroy();
    return res.status(401).json({ error: 'Session expired or deactivated' });
  }

  const { telegramId, inviteCode } = req.body;
  if (!telegramId || !inviteCode) return res.status(400).json({ error: 'Telegram ID and invite code required' });

  try {
    const { data: user, error: findErr } = await supabase
      .from('users')
      .select('id, admin_id, username')
      .eq('telegram_id', String(telegramId))
      .maybeSingle();

    if (findErr || !user) return res.status(404).json({ error: 'User not found' });
    if (user.admin_id !== admin.id) return res.status(403).json({ error: 'User not assigned to you' });

    await supabase.from('users').update({ invite_code: inviteCode }).eq('telegram_id', String(telegramId));

    const { data: existingTrack } = await supabase
      .from('invite_tracking')
      .select('id')
      .eq('telegram_id', String(telegramId))
      .eq('invite_code', inviteCode)
      .maybeSingle();

    if (!existingTrack) {
      await supabase
        .from('invite_tracking')
        .insert({
          telegram_id: String(telegramId),
          username: user.username,
          invite_code: inviteCode,
          admin_id: admin.id,
          admin_name: admin.name
        });
    }

    if (users[String(telegramId)]) users[String(telegramId)].invite_code = inviteCode;

    Audit.adminAction('UPDATE_INVITE_CODE', admin.id, req.ip, { targetUserId: telegramId, newInviteCode: inviteCode });
    res.json({ success: true, message: 'Invite code updated' });
  } catch (err) {
    console.error('Error updating invite code:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  LEGACY ADMIN BALANCE MANAGEMENT
// ================================================================
app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const user = await loadUser(strId, 'unknown', null, null, true);
    user.balance += amt;
    user._lastFetch = Date.now();
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
    const playerSocket = getSocketByUserId(strId);
    if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
    res.json({ success: true, newBalance: user.balance });
  } catch (err) {
    console.error('Error in admin/add-balance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/set-balance', async (req, res) => {
  const { secret, userId, newBalance } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(userId);
  const newBal = Number(newBalance);
  if (isNaN(newBal) || newBal < 0) return res.status(400).json({ error: 'Balance must be non-negative' });
  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', strId)
      .maybeSingle();
    if (fetchErr || !existing) return res.status(404).json({ error: 'User not found' });
    await supabase.from('users').update({ balance: newBal }).eq('telegram_id', strId);
    if (users[strId]) { users[strId].balance = newBal; users[strId]._lastFetch = Date.now(); }
    else await loadUser(strId, existing.username, existing.telegram_handle, null, true);
    Audit.adminAction('ADMIN_SET_BALANCE', 'admin', req.ip, { targetUserId: strId, oldBalance: existing.balance, newBalance: newBal });
    const playerSocket = getSocketByUserId(strId);
    if (playerSocket) playerSocket.emit('balanceUpdate', newBal);
    res.json({ success: true, newBalance: newBal });
  } catch (err) {
    console.error('Error in admin/set-balance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    if (findErr || !user) return res.status(404).json({ error: 'User not found' });
    await supabase.from('users').delete().eq('telegram_id', strId);
    for (const stake of [10, 20, 30]) {
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
    res.json({ success: true, message: `User ${strId} deleted` });
  } catch (err) {
    console.error('Error deleting user:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  BINGO GAME LOGIC
// ================================================================
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
  10: createGameState(10),
  20: createGameState(20),
  30: createGameState(30)
};

const BOT_IDS = [
  '1945854', '8696548', '78963521', '45896872', '1236584',
  '4567890', '9876543', '3216549', '7539512'
];
const botBalances = new Map();
BOT_IDS.forEach(id => botBalances.set(id, 1000));

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
const forceBotWinNextGame = { 20: false, 10: false, 30: false };
let globalForcedBotId = null;
let botGameHistory = [];
const BOT_NAME_REFRESH_MS = 12 * 60 * 60 * 1000;
const botNameAssignments = new Map();

// ★ NEW ★ ─────────────────────────────────────────────────────
//  Round winners history for the admin dashboard (last N rounds)
//  One entry per winner. Newest first.
// ──────────────────────────────────────────────────────────────
const ROUND_WINNERS_LIMIT = 10;
const roundWinnersHistory = [];

function recordRoundWinners(entry) {
  // entry: { round, stake, time, winningNumber, totalPrize, winners:[...] }
  const flattened = entry.winners.map(w => ({
    round: entry.round,
    stake: entry.stake,
    time: entry.time,
    winningNumber: entry.winningNumber,
    totalPrize: entry.totalPrize,
    telegramId: w.telegramId,
    username: w.username,
    cardNumber: w.cardNumber,
    isBot: !!w.isBot,
    prize: w.prize
  }));

  // newest first
  roundWinnersHistory.unshift(...flattened);
  if (roundWinnersHistory.length > ROUND_WINNERS_LIMIT) {
    roundWinnersHistory.length = ROUND_WINNERS_LIMIT;
  }

  // live-push to every connected admin dashboard
  try {
    adminNamespace.emit('admin:winnerHistory', roundWinnersHistory);
  } catch (e) {
    // adminNamespace not yet initialized (very unlikely at runtime)
  }

  // optional durable copy
  for (const w of flattened) {
    writeQueue.push('round_winner', {
      round_number: w.round,
      stake: w.stake,
      telegram_id: w.telegramId,
      username: w.username,
      card_number: w.cardNumber,
      is_bot: w.isBot,
      prize: w.prize,
      winning_number: w.winningNumber,
      total_prize: w.totalPrize
    });
  }
}
// ★ END NEW ★

function getBotName(botId) {
  const now = Date.now();
  const entry = botNameAssignments.get(botId);
  if (entry && (now - entry.assignedAt) < BOT_NAME_REFRESH_MS) return entry.name;
  const newName = getRandomMaleEthiopianName();
  botNameAssignments.set(botId, { name: newName, assignedAt: now });
  return newName;
}

// ================================================================
//  SNAPSHOT MANAGER
// ================================================================
class SnapshotManager {
  constructor(supabase, games, intervalMs = 30000) {
    this.supabase = supabase;
    this.games = games;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.saveAll(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async saveAll() {
    for (const stake of [10, 20, 30]) {
      const game = this.games[stake];
      if (!game || game.status !== 'running') continue;
      try {
        await this.supabase.from('active_game_snapshots').upsert({
          stake,
          state: {
            status: game.status,
            players: game.players.map(p => ({
              telegramId: p.telegramId,
              username: p.username,
              card: p.card,
              cardNumber: p.cardNumber,
              markedNumbers: p.markedNumbers,
              isBot: !!p.isBot
            })),
            calledNumbers: game.calledNumbers,
            prizePool: game.prizePool,
            entryFee: game.entryFee,
            winners: game.winners || []
          },
          updated_at: new Date().toISOString()
        }, { onConflict: 'stake' });
      } catch (err) {
        console.error(`[Snapshot] Failed to save stake ${stake}:`, err.message);
      }
    }
  }

  async clear(stake) {
    try {
      await this.supabase.from('active_game_snapshots').delete().eq('stake', stake);
    } catch (err) {
      console.error(`[Snapshot] Failed to clear stake ${stake}:`, err.message);
    }
  }

  async recoverOnBoot() {
    try {
      const { data: snapshots, error } = await this.supabase
        .from('active_game_snapshots')
        .select('*');

      if (error) throw error;
      if (!snapshots || snapshots.length === 0) {
        console.log('✅ No crashed games to recover');
        return;
      }

      for (const snap of snapshots) {
        const age = Date.now() - new Date(snap.updated_at).getTime();
        const ageMin = Math.round(age / 60000);

        console.log(`⚠️ Recovering stake ${snap.stake} (snapshot age: ${ageMin}m)`);

        const players = snap.state.players || [];
        const stake = snap.stake;
        const entryFee = snap.state.entryFee || stake;

        for (const p of players) {
          if (p.isBot) continue;
          try {
            const { data: user } = await this.supabase
              .from('users')
              .select('balance')
              .eq('telegram_id', p.telegramId)
              .maybeSingle();
            if (!user) continue;

            const refundAmount = entryFee;
            const newBalance = Number(user.balance) + refundAmount;

            await this.supabase
              .from('users')
              .update({ balance: newBalance })
              .eq('telegram_id', p.telegramId);

            if (users[p.telegramId]) {
              users[p.telegramId].balance = newBalance;
              users[p.telegramId]._lastFetch = Date.now();
            }

            console.log(`💸 Refunded ${refundAmount} ETB to ${p.telegramId}`);
          } catch (e) {
            console.error(`Refund failed for ${p.telegramId}:`, e.message);
          }
        }

        logAuditEvent({
          eventType: 'GAME_CRASH_RECOVERED',
          roomId: `stake_${stake}`,
          userId: 'system',
          details: {
            stake,
            playersRefunded: players.filter(p => !p.isBot).length,
            snapshotAge: ageMin,
            calledNumbers: snap.state.calledNumbers?.length || 0
          }
        });
      }

      await this.supabase.from('active_game_snapshots').delete().neq('stake', 0);
      console.log('✅ Crash recovery complete');
    } catch (err) {
      console.error('[Snapshot] Recovery error:', err.message);
    }
  }
}

const snapshotManager = new SnapshotManager(supabase, games);
snapshotManager.start();

// ================================================================
//  BOT JOIN / REMOVE
// ================================================================
function addSingleBotToGame(botId, stake) {
  if (stake !== 20) return false;
  const game = getGame(stake);
  if (!game || game.status !== 'lobby') return false;
  if (game.players.find(p => p.telegramId === botId)) return false;
  const balance = botBalances.get(botId) || 0;
  if (balance < game.entryFee) return false;

  const availableNumbers = [];
  for (let i = 1; i <= 100; i++) {
    if (!game.takenCardNumbers.has(i)) availableNumbers.push(i);
  }
  if (availableNumbers.length === 0) return false;

  const cardNumber = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];
  const card = game.cardSet[cardNumber - 1];
  const botName = getBotName(botId);

  const botPlayer = {
    telegramId: botId,
    username: botName,
    card,
    markedNumbers: [],
    cardNumber,
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
  return true;
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

// ================================================================
//  BINGO CLAIM
// ================================================================
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
    cardNumber: player.cardNumber,
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
    game.bingoGraceTimeout = setTimeout(() => endGameWithWinners(stake), 3000);
  }
}

function getGame(stake) { return games[stake]; }

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
        telegram_handle: user ? user.telegram_handle : null,
        isBot: p.isBot || false
      });
    });
  }
  return allPlayers;
}

// ================================================================
//  THROTTLED ADMIN NOTIFY
// ================================================================
let adminDirty = false;

function notifyAdminClients() {
  adminDirty = true;
}

function buildAdminSnapshot() {
  return {
    players: getAllPlayersList(),
    gameStatus: {
      10: games[10].status,
      20: games[20].status,
      30: games[30].status
    }
  };
}

setInterval(() => {
  if (!adminDirty) return;
  adminDirty = false;
  adminNamespace.emit('admin:playersList', buildAdminSnapshot());
}, 3000);

// ================================================================
//  PUBLIC NAMESPACE (stake page)
// ================================================================
const publicNamespace = io.of('/public');
publicNamespace.on('connection', (socket) => {
  for (const stake of [10, 20, 30]) {
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

// ================================================================
//  RESET / START / CALLING
// ================================================================
function resetGame(stake) {
  const game = getGame(stake);
  clearInterval(game.callInterval);
  clearTimeout(game.lobbyTimer);
  clearTimeout(game.bingoGraceTimeout);
  for (const timeout of game.botTimeouts) clearTimeout(timeout);
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

  if (stake === 20) {
    game.forceActive = false;
    game.forcedBotId = null;
  }

  const lobbyPayload = {
    stake,
    startsIn: 45,
    takenNumbers: Array.from(game.takenCardNumbers),
    playersCount: game.players.length
  };
  io.to(`stake_${stake}`).emit('lobbyState', lobbyPayload);
  io.emit('lobbyState', lobbyPayload);
  publicNamespace.emit('lobbyState', lobbyPayload);

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
      user._lastFetch = Date.now();
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', p.telegramId);
      const playerSocket = getSocketByUserId(p.telegramId);
      if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
    }
  }

  const totalEntryFees = game.entryFee * game.players.length;
  game.prizePool = game.players.length === 1 ? totalEntryFees : 0.8 * totalEntryFees;

  game.status = 'running';
  game.calledNumbers = [];
  game.winningNumber = null;
  for (const p of game.players) if (p.isBot) p.hasCalledBingo = false;

  io.to(`stake_${stake}`).emit('gameStarted', {
    stake,
    prizePool: game.prizePool,
    playersCount: game.players.length
  });
  notifyAdminClients();
  startCalling(stake);
}

// ================================================================
//  NUMBER CALLING  — no calledNumbers array in payload
// ================================================================
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

    io.to(`stake_${stake}`).emit('numberCalled', { stake, number });

    Audit.numberDrawn(`stake_${stake}`, {
      drawnNumber: number,
      drawIndex: game.calledNumbers.length,
      timestamp: new Date().toISOString()
    });

    if (stake === 20 && game.forceActive && callCount === 21) {
      if (game.winners.length === 0) {
        const forcedBot = game.players.find(p => p.telegramId === game.forcedBotId);
        if (forcedBot) {
          const flat = forcedBot.card.flat();
          if (flat.includes(number) && !forcedBot.markedNumbers.includes(number)) {
            forcedBot.markedNumbers.push(number);
          }
          handleBingoClaim(game.forcedBotId, stake, true);
          game.forceActive = false;
          forceBotWinNextGame[20] = false;
          return;
        }
      } else {
        game.forceActive = false;
        forceBotWinNextGame[20] = false;
      }
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

// ================================================================
//  END GAME  — REWRITTEN: fast critical path + queued writes
// ================================================================
async function endGameWithWinners(stake) {
  const game = getGame(stake);
  game.status = 'ended';
  clearInterval(game.callInterval);
  gameCounter++;

  // ---- Bot forcing logic ----
  if (stake === 20) {
    const realWinners = game.winners.filter(w => !w.isBot);
    const botWinners = game.winners.filter(w => w.isBot);
    if (realWinners.length > 0 && botWinners.length === 0) {
      forceBotWinNextGame[20] = true;
      const eligibleBots = game.players.filter(p => p.isBot);
      if (eligibleBots.length > 0) {
        globalForcedBotId = eligibleBots.reduce((a, b) =>
          (botBalances.get(a.telegramId) || 0) < (botBalances.get(b.telegramId) || 0) ? a : b
        ).telegramId;
      }
    }
    if (botWinners.length > 0) forceBotWinNextGame[20] = false;
  }

  const totalEntryFees = game.players.length * game.entryFee;
  const houseProfit = totalEntryFees - game.prizePool;

  // ---- Prepare winner lists ----
  const realWinnersFinal = game.winners.filter(w => !w.isBot);
  if (realWinnersFinal.length > 0) {
    game.winners = game.winners.filter(w => !w.isBot || w.isForced);
  }

  const finalRealWinners = game.winners.filter(w => !w.isBot);
  const finalBotWinners = game.winners.filter(w => w.isBot);

  let prizeEachReal = 0;
  let prizeEachBot = 0;
  if (finalRealWinners.length > 0) {
    prizeEachReal = Math.floor(game.prizePool / finalRealWinners.length);
  } else if (finalBotWinners.length > 0) {
    prizeEachBot = Math.floor(game.prizePool / finalBotWinners.length);
  }

  // ============================================================
  //  🔥 CRITICAL PATH — parallel writes we must wait for
  // ============================================================
  const balanceUpdates = finalRealWinners.map(w => {
    const user = users[w.telegramId];
    if (!user) return null;
    user.balance += prizeEachReal;
    user._lastFetch = Date.now();
    return { telegram_id: w.telegramId, balance: user.balance };
  }).filter(Boolean);

  const criticalTasks = [];

  if (balanceUpdates.length > 0) {
    criticalTasks.push(
      supabase.from('users').upsert(balanceUpdates, { onConflict: 'telegram_id' })
    );
  }

  let gameRoundId = null;
  if (totalEntryFees > 0) {
    criticalTasks.push(
      supabase
        .from('game_rounds')
        .insert({
          total_entry_fees: totalEntryFees,
          prize_pool: game.prizePool,
          house_profit: houseProfit,
          stake
        })
        .select()
        .single()
        .then(res => { gameRoundId = res.data?.id; return res; })
    );
  }

  await Promise.allSettled(criticalTasks);

  // Bots get their prize in memory
  for (const w of finalBotWinners) {
    const bal = botBalances.get(w.telegramId) || 0;
    botBalances.set(w.telegramId, bal + prizeEachBot);
  }

  // Push balance updates to winners' sockets
  for (const w of finalRealWinners) {
    const s = getSocketByUserId(w.telegramId);
    if (s && users[w.telegramId]) s.emit('balanceUpdate', users[w.telegramId].balance);
  }

  // ============================================================
  //  🟢 COLD PATH — queued, don't block
  // ============================================================
  if (gameRoundId && houseProfit > 0) {
    const adminGroups = {};
    for (const player of game.players) {
      if (player.isBot) continue;
      const user = users[player.telegramId];
      if (!user?.admin_id) continue;

      if (!adminGroups[user.admin_id]) adminGroups[user.admin_id] = { totalEntryFees: 0 };
      adminGroups[user.admin_id].totalEntryFees += game.entryFee;
    }

    const adminCommissionFraction = parseFloat(process.env.ADMIN_COMMISSION_PERCENTAGE) || 0.40;
    const adminShareTotal = houseProfit * adminCommissionFraction;

    for (const [adminId, data] of Object.entries(adminGroups)) {
      const share = totalEntryFees > 0
        ? (data.totalEntryFees / totalEntryFees) * adminShareTotal
        : 0;
      if (share > 0) {
        writeQueue.push('admin_contribution', {
          game_round_id: gameRoundId,
          admin_id: parseInt(adminId),
          total_entry_fees: data.totalEntryFees,
          house_profit_share: share
        });
      }
    }
  }

  // Audit log
  writeQueue.push('audit_log', {
    event_type: 'WIN_PAID_OUT',
    room_id: `stake_${stake}`,
    user_id: 'system',
    ip_address: null,
    details: {
      stake,
      winners: finalRealWinners.map(w => ({
        telegramId: w.telegramId,
        cardNumber: w.cardNumber,
        prize: prizeEachReal
      })),
      totalPrizePool: game.prizePool,
      winningNumber: game.winningNumber
    }
  });

  // Rapid-win detection
  for (const w of finalRealWinners) {
    detectRapidWins(`stake_${stake}`, w.telegramId, null);
  }

  // Bot history
  if (stake === 20) {
    for (const bot of game.players.filter(p => p.isBot)) {
      const winner = game.winners.find(w => w.telegramId === bot.telegramId);
      botGameHistory.push({
        botId: bot.telegramId,
        gameNumber: gameCounter,
        date: new Date().toISOString(),
        stake: game.entryFee,
        prizeWon: winner ? game.prizePool / game.winners.length : 0
      });
    }
  }

  // ============================================================
  //  📢 EMIT gameEnded IMMEDIATELY
  // ============================================================
  if (game.winners.length > 0) {
    const winnerNames = game.winners.map(w => w.username);
    const winningCards = game.winners.map(w => w.cardNumber).filter(c => c != null);

    io.to(`stake_${stake}`).emit('gameEnded', {
      stake,
      winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
      winners: winnerNames,
      winningCards,
      cardNumber: winningCards[0] || null,
      prizeEach: finalRealWinners.length > 0 ? prizeEachReal : prizeEachBot,
      totalPrize: game.prizePool,
      winnerCount: game.winners.length,
      winningNumber: game.winningNumber
    });
  } else {
    io.to(`stake_${stake}`).emit('gameEnded', { stake, noWinner: true });
  }

  // ★ NEW ★ ────────────────────────────────────────────────────
  //  Record this round's winners for the admin dashboard BEFORE
  //  game.winners gets cleared below.
  // ────────────────────────────────────────────────────────────
  if (game.winners.length > 0) {
    recordRoundWinners({
      round: gameCounter,
      stake,
      time: new Date().toISOString(),
      winningNumber: game.winningNumber,
      totalPrize: game.prizePool,
      winners: game.winners.map(w => ({
        telegramId: w.telegramId,
        username: w.username,
        cardNumber: w.cardNumber,
        isBot: !!w.isBot,
        prize: !w.isBot ? prizeEachReal : prizeEachBot
      }))
    });
  }
  // ★ END NEW ★

  // ============================================================
  //  🚀 RESET GAME  — players wait for this only
  // ============================================================
  game.winners = [];
  clearTimeout(game.bingoGraceTimeout);
  game.bingoGraceTimeout = null;

  snapshotManager.clear(stake);
  setTimeout(() => resetGame(stake), 3000);
  notifyAdminClients();
}

// ================================================================
//  BOT ADMIN ENDPOINTS
// ================================================================
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
  if (!game || game.status !== 'running') return res.status(400).json({ error: 'Game is not running' });
  const player = game.players.find(p => p.telegramId === botId);
  if (!player) return res.status(400).json({ error: 'Bot is not in the current game' });
  if (game.winners.find(w => w.telegramId === botId)) return res.status(400).json({ error: 'Bot already won this game' });

  if (game.winningNumber === null) {
    game.winningNumber = game.calledNumbers.length > 0 ? game.calledNumbers[game.calledNumbers.length - 1] : 1;
  }
  game.winners.push({
    telegramId: botId,
    username: player.username,
    cardNumber: player.cardNumber,
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
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  let history = botGameHistory;
  if (from) {
    const fromDate = new Date(from);
    fromDate.setHours(0, 0, 0, 0);
    history = history.filter(entry => new Date(entry.date) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    history = history.filter(entry => new Date(entry.date) <= toDate);
  }
  res.json({ success: true, history, from: from || null, to: to || null });
});

// ================================================================
//  DEPOSIT REQUEST  — with idempotency
// ================================================================
const handleDepositRequest = async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { phone, amount, payment_type, transaction_reference, admin_id, proof_type, client_request_id } = req.body;
  const amt = Number(amount);
  const photoFile = req.file;

  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  if (!admin_id) return res.status(400).json({ error: 'Please select a deposit account' });

  if (client_request_id) {
    const { data: existing } = await supabase
      .from('deposit_requests')
      .select('id, status')
      .eq('client_request_id', client_request_id)
      .maybeSingle();
    if (existing) {
      return res.json({
        success: true,
        requestId: existing.id,
        message: 'Deposit already submitted',
        duplicate: true
      });
    }
  }

  const isImageProof = proof_type === 'image'
    && transaction_reference
    && typeof transaction_reference === 'string'
    && transaction_reference.startsWith('data:image/');
  const hasFileProof = !!photoFile;
  const hasTextProof = transaction_reference && !isImageProof;

  if (!isImageProof && !hasFileProof && !hasTextProof) {
    return res.status(400).json({ error: 'Please upload a payment screenshot or provide an invoice number' });
  }

  let extractedTxn = null;
  let base64Buffer = null;
  let base64Mime = null;
  let base64Ext = 'jpg';

  if (isImageProof) {
    const match = transaction_reference.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image data format' });
    base64Mime = `image/${match[1]}`;
    base64Ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    base64Buffer = Buffer.from(match[2], 'base64');
    if (base64Buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
  } else if (hasTextProof) {
    extractedTxn = extractTransactionNumber(transaction_reference);
    if (!extractedTxn) {
      return res.status(400).json({ error: 'Could not extract a valid transaction number from the provided text.' });
    }
  }

  if (extractedTxn) {
    const { data: existing } = await supabase
      .from('deposit_requests')
      .select('id')
      .eq('transaction_reference', extractedTxn)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: 'This transaction number has already been used.' });
  }

  try {
    const { data: admin, error: adminErr } = await supabase
      .from('admins')
      .select('id, name, telebirr_number, cbebirr_number, mpesa_number')
      .eq('id', admin_id)
      .eq('is_active', true)
      .maybeSingle();
    if (adminErr || !admin) return res.status(400).json({ error: 'Invalid deposit account' });

    const methodField = `${payment_type}_number`;
    if (!admin[methodField]) return res.status(400).json({ error: `Admin does not support ${payment_type} deposits` });

    const user = await loadUser(userId, null, null, null, false);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let photoUrl = null;
    let uploadBuffer = null;
    let uploadMime = null;
    let uploadExt = 'jpg';

    if (photoFile) {
      uploadBuffer = photoFile.buffer;
      uploadMime = photoFile.mimetype;
      uploadExt = (photoFile.originalname.split('.').pop() || 'jpg').toLowerCase();
    } else if (base64Buffer) {
      uploadBuffer = base64Buffer;
      uploadMime = base64Mime;
      uploadExt = base64Ext;
    }

    if (uploadBuffer) {
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketExists = buckets?.some(b => b.name === 'deposit-photos');
      if (!bucketExists) {
        await supabase.storage.createBucket('deposit-photos', {
          public: true,
          file_size_limit: 5242880,
          allowed_mime_types: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']
        });
      }

      const fileName = `${uuidv4()}.${uploadExt}`;
      const filePath = `deposit-proofs/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('deposit-photos')
        .upload(filePath, uploadBuffer, {
          contentType: uploadMime,
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        let errorMsg = 'Failed to upload screenshot proof';
        if (uploadError.message.includes('bucket not found')) errorMsg = 'Storage bucket not configured. Please contact admin.';
        else if (uploadError.message.includes('permission')) errorMsg = 'Permission denied. Check Supabase storage policies.';
        return res.status(500).json({ error: errorMsg, details: uploadError.message });
      }

      const { data: publicUrlData } = supabase.storage.from('deposit-photos').getPublicUrl(filePath);
      photoUrl = publicUrlData?.publicUrl || null;
    }

    const { data, error } = await supabase.from('deposit_requests').insert({
      telegram_id: userId,
      username: user.username,
      amount: amt,
      status: 'pending',
      phone: phone || null,
      payment_type,
      transaction_reference: extractedTxn,
      proof_photo_url: photoUrl,
      admin_id: admin.id,
      assigned_deposit_number: admin[methodField],
      client_request_id: client_request_id || null
    }).select().single();

    if (error) throw error;

    Audit.depositInitiated(userId, req.ip, {
      transactionId: data.id.toString(),
      amount: amt,
      currency: 'ETB',
      method: payment_type,
      adminId: admin.id,
      adminName: admin.name,
      transactionReference: extractedTxn,
      hasPhoto: !!photoUrl
    });

    res.json({
      success: true,
      requestId: data.id,
      message: `Deposit request of ${amt} ETB via ${payment_type} submitted to ${admin.name}.`,
      adminName: admin.name,
      adminNumber: admin[methodField]
    });
  } catch (err) {
    console.error('Deposit request error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ================================================================
//  WITHDRAW REQUEST  — with idempotency
// ================================================================
app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { amount, phone, withdrawal_type, name, client_request_id } = req.body;
  const amt = Number(amount);

  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(withdrawal_type)) return res.status(400).json({ error: 'Invalid withdrawal type' });
  const receiver = (phone || '').trim();
  if (!receiver || receiver.length < 10) return res.status(400).json({ error: 'Valid receiver phone/account required' });
  const receiverName = (name || '').trim();
  if (!receiverName) return res.status(400).json({ error: 'Account holder name is required' });

  if (client_request_id) {
    const { data: existing } = await supabase
      .from('withdrawal_requests')
      .select('id, status')
      .eq('client_request_id', client_request_id)
      .maybeSingle();
    if (existing) {
      return res.json({ success: true, requestId: existing.id, duplicate: true });
    }
  }

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
      telegram_id: userId,
      username: user.username,
      amount: amt,
      status: 'pending',
      phone_number: receiver,
      withdrawal_type,
      receiver_name: receiverName,
      admin_id: adminId,
      admin_name: adminName,
      client_request_id: client_request_id || null
    }).select().single();

    if (error) throw error;

    Audit.withdrawalRequested(userId, req.ip, {
      transactionId: data.id.toString(),
      amount: amt,
      currency: 'ETB',
      method: withdrawal_type,
      receiver,
      name: receiverName,
      adminId,
      adminName
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

// ================================================================
//  ADMIN SESSION-BASED ENDPOINTS
// ================================================================
app.get('/admin/deposits', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  let query = supabase.from('deposit_requests').select('*').eq('admin_id', admin.id);
  const { from, to, method, status } = req.query;

  if (from) { const d = new Date(from); d.setHours(0, 0, 0, 0); query = query.gte('created_at', d.toISOString()); }
  if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); query = query.lte('created_at', d.toISOString()); }
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
      playerCount,
      totalDeposits: depositBalance,
      rawDeposits,
      depositBalance,
      pendingCount: data.filter(d => d.status === 'pending').length,
      approvedToday
    }
  });
});

app.get('/admin/withdrawals', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  let query = supabase.from('withdrawal_requests').select('*').eq('admin_id', admin.id);
  const { from, to, method, status } = req.query;

  if (from) { const d = new Date(from); d.setHours(0, 0, 0, 0); query = query.gte('created_at', d.toISOString()); }
  if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); query = query.lte('created_at', d.toISOString()); }
  if (method && method !== 'all') query = query.eq('withdrawal_type', method);
  if (status && status !== 'all') query = query.eq('status', status);
  else query = query.eq('status', 'pending');

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;

  res.json({ requests: data, admin: { id: admin.id, name: admin.name, phone: admin.phone } });
});

app.get('/admin/holding-balance', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }
  try {
    const holding = await getAdminHoldingBalance(admin.id);
    res.json({ success: true, holding });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/process-deposit', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  const { requestId, action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    const { data: reqData, error: fetchErr } = await supabase
      .from('deposit_requests')
      .select('*')
      .eq('id', requestId)
      .eq('admin_id', admin.id)
      .single();
    if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      const holding = await getAdminHoldingBalance(admin.id);
      const newHolding = holding + reqData.amount;
      if (newHolding > 1500) {
        return res.status(400).json({
          error: `Admin's total approved deposits exceeds 1500 ETB (current: ${holding.toFixed(0)} ETB). Please withdraw excess to super admin.`
        });
      }

      const user = await loadUser(reqData.telegram_id, null, null, null, true);
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.balance += reqData.amount;
      user._lastFetch = Date.now();
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
      await supabase.from('deposit_requests').update({
        status: 'approved',
        processed_at: new Date().toISOString()
      }).eq('id', requestId);

      Audit.depositCompleted(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(),
        amount: reqData.amount,
        currency: 'ETB',
        method: reqData.payment_type || 'unknown',
        adminId: admin.id,
        adminName: admin.name
      });

      if (!user.first_deposit_amount || user.first_deposit_amount === 0) {
        user.first_deposit_amount = reqData.amount;
        await supabase.from('users').update({ first_deposit_amount: user.first_deposit_amount }).eq('telegram_id', reqData.telegram_id);
      }

      const playerSocket = getSocketByUserId(reqData.telegram_id);
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
        reason: 'rejected_by_admin'
      });

      const playerSocket = getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
      res.json({ success: true });
    }
  } catch (err) {
    console.error('Process deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/stats', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  try {
    const playerCount = await getAdminPlayerCount(admin.id);

    const { data: deposits } = await supabase
      .from('deposit_requests')
      .select('amount, status, created_at')
      .eq('admin_id', admin.id);

    const rawDeposits = deposits.filter(d => d.status === 'approved').reduce((sum, d) => sum + Number(d.amount), 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDepositsFromRequests = deposits
      .filter(d => d.status === 'approved' && new Date(d.created_at) >= today)
      .reduce((sum, d) => sum + Number(d.amount), 0);

    const { data: adjustments } = await supabase
      .from('admin_deposit_adjustments')
      .select('amount, created_at')
      .eq('admin_id', admin.id)
      .gt('amount', 0);

    const adjustmentTotal = adjustments.reduce((sum, a) => sum + Number(a.amount), 0);
    const adjustmentToday = adjustments.filter(a => new Date(a.created_at) >= today).reduce((sum, a) => sum + Number(a.amount), 0);

    const totalDeposits = rawDeposits + adjustmentTotal;
    const todayDeposits = todayDepositsFromRequests + adjustmentToday;

    const { data: withdrawals } = await supabase
      .from('withdrawal_requests')
      .select('amount, status')
      .eq('admin_id', admin.id);

    const totalWithdrawals = withdrawals.filter(w => w.status === 'approved').reduce((sum, w) => sum + Number(w.amount), 0);
    const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
    const pendingDeposits = deposits.filter(d => d.status === 'pending').length;

    const depositBalance = await getAdminHoldingBalance(admin.id);
    const { pending: pendingEarnings, earned: totalEarned } = await getAdminEarnings(admin.id);

    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, phone: admin.phone, deposit_number: admin.deposit_number },
      stats: {
        playerCount,
        availableBalance: pendingEarnings,
        totalEarned,
        depositBalance,
        rawDeposits,
        totalDeposits,
        todayDeposits,
        totalWithdrawals,
        pendingWithdrawals,
        pendingDeposits
      }
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/players', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  try {
    const players = await getAdminPlayers(admin.id);
    const playersWithStats = await Promise.all(players.map(async (player) => {
      const { data: deposits } = await supabase
        .from('deposit_requests')
        .select('amount, status, created_at, proof_photo_url')
        .eq('telegram_id', player.telegram_id)
        .eq('admin_id', admin.id)
        .order('created_at', { ascending: false })
        .limit(5);
      return { ...player, recentDeposits: deposits || [] };
    }));

    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, phone: admin.phone },
      players: playersWithStats,
      count: playersWithStats.length
    });
  } catch (err) {
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
  if (!['add', 'subtract'].includes(operation)) return res.status(400).json({ error: 'Invalid operation' });

  try {
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (userErr || !user) return res.status(404).json({ error: 'Player not found' });
    if (user.admin_id !== admin.id) return res.status(403).json({ error: 'This player is not assigned to you' });

    if (operation === 'add') {
      const currentHolding = await getAdminHoldingBalance(admin.id);
      if (currentHolding + amt > 1500) {
        return res.status(400).json({
          error: `Cannot add ${amt} ETB. Admin holding balance would exceed 1500 ETB (current: ${currentHolding.toFixed(0)} ETB).`
        });
      }
    }

    let oldBalance = Number(user.balance);
    let newBalance = operation === 'add' ? oldBalance + amt : oldBalance - amt;
    if (newBalance < 0) return res.status(400).json({ error: 'Insufficient player balance' });

    await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegramId);

    const adjustmentAmount = operation === 'add' ? amt : -amt;
    await supabase.from('admin_deposit_adjustments').insert({
      admin_id: admin.id,
      amount: adjustmentAmount,
      type: 'manual_balance_adjustment',
      description: `Manual ${operation} of ${amt} ETB for player ${telegramId}`,
      created_by: admin.id,
      created_at: new Date().toISOString()
    });

    if (users[telegramId]) {
      users[telegramId].balance = newBalance;
      users[telegramId]._lastFetch = Date.now();
    } else {
      await loadUser(telegramId, user.username, user.telegram_handle, null, true);
    }

    Audit.adminAction('ADMIN_MANUAL_BALANCE_ADJUST', admin.id, req.ip, {
      targetUserId: telegramId,
      operation,
      amount: amt,
      oldBalance,
      newBalance
    });

    const playerSocket = getSocketByUserId(telegramId);
    if (playerSocket) playerSocket.emit('balanceUpdate', newBalance);

    res.json({ success: true, newBalance, message: `Balance ${operation}ed by ${amt} ETB` });
  } catch (err) {
    console.error('Error updating player balance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  const { requestId, action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    const { data: reqData, error: fetchErr } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', requestId)
      .eq('admin_id', admin.id)
      .single();
    if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      const user = await loadUser(reqData.telegram_id, null, null, null, true);
      if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
      user.balance -= reqData.amount;
      user._lastFetch = Date.now();
      await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
      await supabase.from('withdrawal_requests').update({
        status: 'approved',
        processed_at: new Date().toISOString()
      }).eq('id', requestId);

      Audit.withdrawalCompleted(reqData.telegram_id, req.ip, {
        transactionId: requestId.toString(),
        amount: reqData.amount,
        method: reqData.withdrawal_type || 'N/A',
        receiver: reqData.phone_number,
        adminId: admin.id,
        adminName: admin.name
      });

      const playerSocket = getSocketByUserId(reqData.telegram_id);
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
        reason: 'rejected_by_admin'
      });

      const playerSocket = getSocketByUserId(reqData.telegram_id);
      if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  DAILY COMMISSION
// ================================================================
const DAILY_COMMISSION_HOUR = 0;
const DAILY_COMMISSION_MINUTE = 0;

async function calculateDailyCommissions() {
  console.log('⏰ Running daily commission calculation...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  try {
    const { data: admins, error: adminErr } = await supabase
      .from('admins')
      .select('id, name')
      .eq('is_active', true);
    if (adminErr) throw adminErr;

    for (const admin of admins) {
      const { data: contributions } = await supabase
        .from('game_admin_contributions')
        .select('house_profit_share, total_entry_fees, created_at')
        .eq('admin_id', admin.id)
        .gte('created_at', yesterday.toISOString())
        .lt('created_at', today.toISOString());

      if (contributions && contributions.length > 0) {
        const totalCommission = contributions.reduce((sum, c) => sum + Number(c.house_profit_share), 0);
        const totalEntryFees = contributions.reduce((sum, c) => sum + Number(c.total_entry_fees || 0), 0);
        const totalHouseProfit = contributions.reduce((sum, c) => sum + Number(c.house_profit_share || 0), 0);

        if (totalCommission > 0) {
          const { data: existing } = await supabase
            .from('admin_daily_commissions')
            .select('id')
            .eq('admin_id', admin.id)
            .eq('date', yesterdayStr)
            .maybeSingle();

          if (existing) {
            await supabase
              .from('admin_daily_commissions')
              .update({
                total_entry_fees: totalEntryFees,
                total_house_profit: totalHouseProfit,
                commission_amount: totalCommission
              })
              .eq('id', existing.id);
          } else {
            await supabase
              .from('admin_daily_commissions')
              .insert({
                admin_id: admin.id,
                date: yesterdayStr,
                total_entry_fees: totalEntryFees,
                total_house_profit: totalHouseProfit,
                commission_amount: totalCommission,
                status: 'pending'
              });
          }
        }
      }
    }
    console.log('✅ Daily commission calculation complete!');
  } catch (err) {
    console.error('❌ Daily commission calculation error:', err.message);
  }
}

function scheduleDailyCommission() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(DAILY_COMMISSION_HOUR, DAILY_COMMISSION_MINUTE, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  const msUntilNextRun = nextRun - now;
  console.log(`⏰ Next daily commission calculation at: ${nextRun.toLocaleString()}`);
  setTimeout(() => {
    calculateDailyCommissions();
    setInterval(calculateDailyCommissions, 24 * 60 * 60 * 1000);
  }, msUntilNextRun);
}
scheduleDailyCommission();

app.get('/admin/daily-commissions', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired or deactivated' }); }

  try {
    const { data: dailyCommissions } = await supabase
      .from('admin_daily_commissions')
      .select('*')
      .eq('admin_id', admin.id)
      .order('date', { ascending: false })
      .limit(30);

    const { data: pendingEarnings } = await supabase
      .from('admin_daily_commissions')
      .select('commission_amount')
      .eq('admin_id', admin.id)
      .eq('status', 'pending');
    const totalPending = pendingEarnings.reduce((sum, d) => sum + Number(d.commission_amount), 0);

    const { data: paidEarnings } = await supabase
      .from('admin_daily_commissions')
      .select('commission_amount')
      .eq('admin_id', admin.id)
      .eq('status', 'paid');
    const totalPaid = paidEarnings.reduce((sum, d) => sum + Number(d.commission_amount), 0);

    res.json({
      success: true,
      daily: dailyCommissions,
      stats: { totalEarned: totalPaid, totalPending, totalPaid, totalAvailable: totalPending },
      admin: { id: admin.id, name: admin.name, commission_rate: admin.commission_rate }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/live-commission', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ success: false, error: 'Session expired' }); }

  try {
    const { data: contributions } = await supabase
      .from('game_admin_contributions')
      .select('house_profit_share, total_entry_fees, created_at, game_round_id')
      .eq('admin_id', admin.id);

    const { data: paidCommissions } = await supabase
      .from('admin_daily_commissions')
      .select('commission_amount, status, date')
      .eq('admin_id', admin.id);

    const paidDates = new Set();
    if (paidCommissions) {
      paidCommissions.forEach(c => { if (c.status === 'paid') paidDates.add(c.date); });
    }

    const dailyTotals = {};
    let totalPending = 0;
    let totalPaid = 0;

    if (contributions) {
      for (const contrib of contributions) {
        const dateStr = new Date(contrib.created_at).toISOString().split('T')[0];
        const share = Number(contrib.house_profit_share) || 0;
        const fees = Number(contrib.total_entry_fees) || 0;

        if (!dailyTotals[dateStr]) {
          dailyTotals[dateStr] = {
            date: dateStr,
            totalCommission: 0,
            totalEntryFees: 0,
            isPaid: paidDates.has(dateStr)
          };
        }
        dailyTotals[dateStr].totalCommission += share;
        dailyTotals[dateStr].totalEntryFees += fees;
      }
    }

    const rounds = [];
    for (const [dateStr, data] of Object.entries(dailyTotals)) {
      rounds.push({
        date: dateStr,
        total_entry_fees: data.totalEntryFees,
        commission_amount: data.totalCommission,
        status: data.isPaid ? 'paid' : 'pending'
      });
      if (data.isPaid) totalPaid += data.totalCommission;
      else totalPending += data.totalCommission;
    }
    rounds.sort((a, b) => new Date(b.date) - new Date(a.date));

    let totalEarned = 0;
    if (paidCommissions) {
      paidCommissions.forEach(c => { if (c.status === 'paid') totalEarned += Number(c.commission_amount) || 0; });
    }

    res.json({
      success: true,
      admin: { id: admin.id, name: admin.name, commission_rate: admin.commission_rate },
      stats: { pending: totalPending, paid: totalPaid, totalEarned, totalPending, totalAvailable: totalPending },
      rounds
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/request-withdrawal', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired' }); }

  const { amount, phone, withdrawal_type, receiver_name } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!phone || !receiver_name) return res.status(400).json({ error: 'Phone and receiver name required' });

  try {
    const { data: contributions } = await supabase
      .from('game_admin_contributions')
      .select('house_profit_share, created_at')
      .eq('admin_id', admin.id);

    const { data: paidCommissions } = await supabase
      .from('admin_daily_commissions')
      .select('date')
      .eq('admin_id', admin.id)
      .eq('status', 'paid');

    const paidDates = new Set();
    if (paidCommissions) paidCommissions.forEach(c => paidDates.add(c.date));

    let totalPending = 0;
    if (contributions) {
      for (const contrib of contributions) {
        const dateStr = new Date(contrib.created_at).toISOString().split('T')[0];
        if (!paidDates.has(dateStr)) totalPending += Number(contrib.house_profit_share) || 0;
      }
    }

    if (totalPending < amt) return res.status(400).json({ error: `Insufficient pending earnings. Available: ${totalPending.toFixed(0)} ETB` });

    const { data, error } = await supabase
      .from('admin_withdrawal_requests')
      .insert({
        admin_id: admin.id,
        amount: amt,
        phone,
        withdrawal_type,
        receiver_name,
        status: 'pending'
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, request: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/process-admin-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    const { data: reqData } = await supabase
      .from('admin_withdrawal_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    if (!reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      await supabase
        .from('admin_withdrawal_requests')
        .update({ status: 'approved', processed_at: new Date().toISOString() })
        .eq('id', requestId);
      await supabase
        .from('admin_daily_commissions')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('admin_id', reqData.admin_id)
        .eq('status', 'pending');
    } else {
      await supabase
        .from('admin_withdrawal_requests')
        .update({ status: 'rejected', processed_at: new Date().toISOString() })
        .eq('id', requestId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  SUPER ADMIN
// ================================================================
async function authSuperAdmin(req, res) {
  const secret = req.query.secret || req.body.secret;
  const validSecret = process.env.ADMIN_SECRET || '01207';

  if (secret && secret === validSecret) return { success: true, adminId: null, via: 'secret' };

  if (req.session.adminId) {
    const isSuper = await isSuperAdmin(req.session.adminId);
    if (isSuper) return { success: true, adminId: req.session.adminId, via: 'session' };
  }
  return { success: false, error: 'Unauthorized' };
}

app.get('/super-admin/admins', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { data: admins, error } = await supabase
      .from('admins')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const adminsWithStats = await Promise.all(admins.map(async (admin) => {
      const playerCount = await getAdminPlayerCount(admin.id);
      const rawDeposits = await getAdminDeposits(admin.id);
      const { data: pendingDeposits } = await supabase
        .from('deposit_requests').select('count').eq('admin_id', admin.id).eq('status', 'pending');

      const { data: withdrawals } = await supabase
        .from('withdrawal_requests').select('amount, status').eq('admin_id', admin.id);

      const totalWithdrawals = withdrawals.filter(w => w.status === 'approved').reduce((sum, w) => sum + Number(w.amount), 0);
      const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
      const { pending: totalPendingEarnings, earned: totalEarned } = await getAdminEarnings(admin.id);
      const holdingBalance = await getAdminHoldingBalance(admin.id);

      return {
        ...admin,
        stats: {
          playerCount,
          totalDeposits: holdingBalance,
          rawDeposits,
          holdingBalance,
          pendingDeposits: pendingDeposits?.[0]?.count || 0,
          totalWithdrawals,
          pendingWithdrawals,
          totalPendingEarnings,
          totalEarned
        }
      };
    }));

    res.json({ success: true, admins: adminsWithStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/super-admin/admin/:adminId', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { adminId } = req.params;
    const { data: admin } = await supabase.from('admins').select('*').eq('id', adminId).maybeSingle();
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const players = await getAdminPlayers(adminId);
    const { data: deposits } = await supabase.from('deposit_requests').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }).limit(20);
    const { data: withdrawals } = await supabase.from('withdrawal_requests').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }).limit(20);
    const { data: earnings } = await supabase.from('admin_daily_commissions').select('*').eq('admin_id', adminId).order('date', { ascending: false }).limit(30);
    const { data: adminWithdrawals } = await supabase.from('admin_withdrawal_requests').select('*').eq('admin_id', adminId).eq('status', 'pending').order('created_at', { ascending: false });

    const { pending: totalPendingEarnings, earned: totalEarned } = await getAdminEarnings(adminId);
    const holdingBalance = await getAdminHoldingBalance(adminId);
    const { data: adjustments } = await supabase.from('admin_deposit_adjustments').select('*').eq('admin_id', adminId).order('created_at', { ascending: false });

    res.json({
      success: true,
      admin,
      stats: {
        players: players.length,
        deposits,
        withdrawals,
        earnings,
        adminWithdrawals,
        totalPendingEarnings,
        totalEarned,
        holdingBalance,
        adjustments: adjustments || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/toggle-admin', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { adminId, isActive } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });

  try {
    if (auth.via === 'session' && parseInt(adminId) === req.session.adminId) {
      return res.status(400).json({ error: 'Cannot change your own status' });
    }
    await supabase.from('admins').update({ is_active: isActive }).eq('id', adminId);
    Audit.adminAction('SUPER_ADMIN_TOGGLE_ADMIN', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, newStatus: isActive });
    res.json({ success: true, message: `Admin ${isActive ? 'activated' : 'deactivated'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/update-commission', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { adminId, commissionRate } = req.body;
  if (!adminId || commissionRate === undefined) return res.status(400).json({ error: 'Admin ID and rate required' });
  if (commissionRate < 0 || commissionRate > 1) return res.status(400).json({ error: 'Rate must be 0-1' });

  try {
    await supabase.from('admins').update({ commission_rate: commissionRate }).eq('id', adminId);
    Audit.adminAction('SUPER_ADMIN_UPDATE_COMMISSION', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, newCommissionRate: commissionRate });
    res.json({ success: true, message: 'Commission rate updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/toggle-deposit-acceptance', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { adminId, acceptDeposits } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });
  if (acceptDeposits === undefined) return res.status(400).json({ error: 'acceptDeposits required' });

  try {
    await supabase.from('admins').update({ accept_deposits: acceptDeposits }).eq('id', adminId);
    Audit.adminAction('SUPER_ADMIN_TOGGLE_DEPOSIT_ACCEPTANCE', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, acceptDeposits });
    res.json({ success: true, message: `Deposit acceptance ${acceptDeposits ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/adjust-deposit-balance', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { adminId, amount, description = '' } = req.body;
  if (!adminId) return res.status(400).json({ error: 'Admin ID required' });
  if (amount === undefined || isNaN(Number(amount)) || amount === 0) return res.status(400).json({ error: 'Valid non-zero amount required' });

  const amt = Number(amount);

  try {
    const { data: admin } = await supabase.from('admins').select('id').eq('id', adminId).eq('is_active', true).maybeSingle();
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const { data: newAdj } = await supabase.from('admin_deposit_adjustments').insert({
      admin_id: adminId,
      amount: amt,
      type: 'super_admin_manual',
      description: description || (amt < 0 ? 'Super admin deduction' : 'Super admin addition'),
      created_by: auth.adminId || null,
      created_at: new Date().toISOString()
    }).select().single();

    const newBalance = await getAdminHoldingBalance(adminId);

    Audit.adminAction('SUPER_ADMIN_ADJUST_DEPOSIT', auth.adminId || 'secret', req.ip, { targetAdminId: adminId, amount: amt, newBalance, description: newAdj.description });

    res.json({ success: true, message: 'Deposit balance adjusted', adjustment: newAdj, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/send-telegram-message', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'Missing userId or message' });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ success: false, error: 'BOT_TOKEN not configured' });

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text: message, parse_mode: 'HTML' })
    });
    const data = await response.json();
    if (data.ok) res.json({ success: true, result: data.result });
    else {
      let errorMsg = data.description || 'Telegram API error';
      if (errorMsg.includes('chat not found')) errorMsg = 'User has not started the bot yet.';
      throw new Error(errorMsg);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/super-admin/admin-withdrawals', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { status = 'pending', limit = 50, from, to, adminId } = req.query;

    let query = supabase
      .from('admin_withdrawal_requests')
      .select('*, admins(name, phone)')
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 100));

    if (status !== 'all') query = query.eq('status', status);
    if (adminId && adminId !== 'all') query = query.eq('admin_id', adminId);
    if (from) {
      const fromDate = new Date(from); fromDate.setHours(0, 0, 0, 0);
      query = query.gte('created_at', fromDate.toISOString());
    }
    if (to) {
      const toDate = new Date(to); toDate.setHours(23, 59, 59, 999);
      query = query.lte('created_at', toDate.toISOString());
    }

    const { data: requests } = await query;
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/super-admin/process-admin-withdrawal', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { requestId, action } = req.body;
  if (!requestId || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid input' });

  try {
    const { data: reqData } = await supabase.from('admin_withdrawal_requests').select('*').eq('id', requestId).single();
    if (!reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/super-admin/platform-stats', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { from, to, adminId } = req.query;
    let userQuery = supabase.from('users').select('*', { count: 'exact', head: true });
    let adminQuery = supabase.from('admins').select('*', { count: 'exact', head: true }).eq('is_active', true);
    let depositQuery = supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    let withdrawalQuery = supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    let roundsQuery = supabase.from('game_rounds').select('house_profit');
    let paidEarningsQuery = supabase.from('admin_daily_commissions').select('commission_amount').eq('status', 'paid');
    let pendingWithdrawalsQuery = supabase.from('admin_withdrawal_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending');

    if (from) {
      const d = new Date(from); d.setHours(0, 0, 0, 0);
      depositQuery = depositQuery.gte('created_at', d.toISOString());
      withdrawalQuery = withdrawalQuery.gte('created_at', d.toISOString());
      roundsQuery = roundsQuery.gte('created_at', d.toISOString());
      paidEarningsQuery = paidEarningsQuery.gte('paid_at', d.toISOString());
      pendingWithdrawalsQuery = pendingWithdrawalsQuery.gte('created_at', d.toISOString());
    }
    if (to) {
      const d = new Date(to); d.setHours(23, 59, 59, 999);
      depositQuery = depositQuery.lte('created_at', d.toISOString());
      withdrawalQuery = withdrawalQuery.lte('created_at', d.toISOString());
      roundsQuery = roundsQuery.lte('created_at', d.toISOString());
      paidEarningsQuery = paidEarningsQuery.lte('paid_at', d.toISOString());
      pendingWithdrawalsQuery = pendingWithdrawalsQuery.lte('created_at', d.toISOString());
    }

    if (adminId && adminId !== 'all') {
      depositQuery = depositQuery.eq('admin_id', adminId);
      withdrawalQuery = withdrawalQuery.eq('admin_id', adminId);
      paidEarningsQuery = paidEarningsQuery.eq('admin_id', adminId);
      pendingWithdrawalsQuery = pendingWithdrawalsQuery.eq('admin_id', adminId);
    }

    let pendingEarningsQuery = supabase.from('game_admin_contributions').select('house_profit_share, created_at');
    if (from) pendingEarningsQuery = pendingEarningsQuery.gte('created_at', new Date(from).toISOString());
    if (to) pendingEarningsQuery = pendingEarningsQuery.lte('created_at', new Date(to).toISOString());
    if (adminId && adminId !== 'all') pendingEarningsQuery = pendingEarningsQuery.eq('admin_id', adminId);

    const [totalUsers, totalAdmins, deposits, withdrawals, rounds, paidEarnings, pendingWithdrawals, pendingEarnings] = await Promise.all([
      userQuery, adminQuery, depositQuery, withdrawalQuery, roundsQuery, paidEarningsQuery, pendingWithdrawalsQuery, pendingEarningsQuery
    ]);

    const totalDeposits = deposits.data?.reduce((sum, d) => sum + Number(d.amount), 0) || 0;
    const totalWithdrawals = withdrawals.data?.reduce((sum, d) => sum + Number(d.amount), 0) || 0;
    const totalHouseProfit = rounds.data?.reduce((sum, r) => sum + Number(r.house_profit), 0) || 0;
    const totalAdminEarnings = paidEarnings.data?.reduce((sum, e) => sum + Number(e.commission_amount), 0) || 0;

    let totalPendingEarnings = 0;
    if (pendingEarnings.data) {
      let paidDatesQuery = supabase.from('admin_daily_commissions').select('date').eq('status', 'paid');
      if (adminId && adminId !== 'all') paidDatesQuery = paidDatesQuery.eq('admin_id', adminId);
      if (from) paidDatesQuery = paidDatesQuery.gte('paid_at', new Date(from).toISOString());
      if (to) paidDatesQuery = paidDatesQuery.lte('paid_at', new Date(to).toISOString());
      const { data: paidDatesData } = await paidDatesQuery;
      const paidDates = new Set(paidDatesData?.map(d => d.date) || []);

      for (const contrib of pendingEarnings.data) {
        const dateStr = new Date(contrib.created_at).toISOString().split('T')[0];
        if (!paidDates.has(dateStr)) totalPendingEarnings += Number(contrib.house_profit_share) || 0;
      }
    }

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers.count || 0,
        totalAdmins: totalAdmins.count || 0,
        totalDeposits,
        totalWithdrawals,
        totalHouseProfit,
        totalAdminEarnings,
        totalPendingEarnings,
        pendingWithdrawals: pendingWithdrawals.count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/super-admin/players', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { adminId, search, limit = 100, page = 1 } = req.query;
    let query = supabase.from('users').select('*', { count: 'exact' });

    if (adminId && adminId !== 'all') query = query.eq('admin_id', adminId);
    if (search) query = query.or(`username.ilike.%${search}%,telegram_handle.ilike.%${search}%,telegram_id.ilike.%${search}%`);

    const limitNum = Math.min(parseInt(limit) || 100, 1000);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limitNum;

    const { data, error, count } = await query.range(offset, offset + limitNum - 1);
    if (error) return res.status(500).json({ success: false, error: error.message });

    const adminIds = [...new Set(data.map(u => u.admin_id).filter(id => id))];
    let adminsMap = {};
    if (adminIds.length) {
      const { data: admins } = await supabase.from('admins').select('id, name').in('id', adminIds);
      if (admins) adminsMap = admins.reduce((acc, a) => { acc[a.id] = a.name; return acc; }, {});
    }

    const players = data.map(u => ({
      ...u,
      admin_name: u.admin_id ? adminsMap[u.admin_id] || null : null
    }));

    res.json({ success: true, players, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil(count / limitNum) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/super-admin/analysis', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  try {
    const { from, to, adminId } = req.query;

    let query = supabase.from('game_admin_contributions').select(`
      admin_id,
      house_profit_share,
      game_rounds!inner (id, stake, created_at)
    `);

    if (from) {
      const fromDate = new Date(from); fromDate.setHours(0, 0, 0, 0);
      query = query.gte('game_rounds.created_at', fromDate.toISOString());
    }
    if (to) {
      const toDate = new Date(to); toDate.setHours(23, 59, 59, 999);
      query = query.lte('game_rounds.created_at', toDate.toISOString());
    }
    if (adminId && adminId !== 'all') query = query.eq('admin_id', adminId);

    const { data: contributions } = await query;
    if (!contributions || contributions.length === 0) return res.json({ success: true, data: [] });

    const grouped = {};
    for (const row of contributions) {
      const aId = row.admin_id;
      const stake = row.game_rounds.stake;
      const key = `${aId}-${stake}`;
      if (!grouped[key]) grouped[key] = { admin_id: aId, stake, total_commission: 0 };
      grouped[key].total_commission += Number(row.house_profit_share) || 0;
    }

    const adminIds = [...new Set(Object.values(grouped).map(g => g.admin_id))];
    let adminsMap = {};
    if (adminIds.length) {
      const { data: admins } = await supabase.from('admins').select('id, name').in('id', adminIds);
      if (admins) adminsMap = admins.reduce((acc, a) => { acc[a.id] = a.name; return acc; }, {});
    }

    const playerCounts = {};
    if (adminIds.length) {
      const { data: userList } = await supabase.from('users').select('admin_id').in('admin_id', adminIds);
      if (userList) {
        for (const u of userList) {
          if (!playerCounts[u.admin_id]) playerCounts[u.admin_id] = 0;
          playerCounts[u.admin_id]++;
        }
      }
    }

    const result = [];
    for (const key of Object.keys(grouped)) {
      const g = grouped[key];
      result.push({
        game_name: `Bingo ${g.stake} ETB`,
        admin_name: adminsMap[g.admin_id] || `Admin ${g.admin_id}`,
        player_count: playerCounts[g.admin_id] || 0,
        total_commission: g.total_commission,
        admin_share: g.total_commission
      });
    }

    result.sort((a, b) => a.game_name.localeCompare(b.game_name) || a.admin_name.localeCompare(b.admin_name));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/super-admin/delete-player', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    const { data: user } = await supabase.from('users').select('telegram_id, username, admin_id').eq('telegram_id', String(telegramId)).maybeSingle();
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    await supabase.from('users').delete().eq('telegram_id', String(telegramId));
    if (users[String(telegramId)]) delete users[String(telegramId)];

    for (const stake of [10, 20, 30]) {
      const game = getGame(stake);
      if (!game) continue;
      const idx = game.players.findIndex(p => p.telegramId === String(telegramId));
      if (idx !== -1) {
        const player = game.players[idx];
        if (player.cardNumber) game.takenCardNumbers.delete(player.cardNumber);
        game.players.splice(idx, 1);
        io.to(`stake_${stake}`).emit('cardTaken', { stake, number: player.cardNumber, takenNumbers: Array.from(game.takenCardNumbers) });
        broadcastPlayerCount(stake);
        notifyAdminClients();
      }
    }

    Audit.adminAction('SUPER_ADMIN_DELETE_PLAYER', auth.adminId || 'secret', req.ip, { targetUserId: telegramId, username: user.username, adminId: user.admin_id });
    res.json({ success: true, message: `Player ${telegramId} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/super-admin/transfer-player', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { telegramId, targetAdminId } = req.body;
  if (!telegramId || !targetAdminId) return res.status(400).json({ error: 'telegramId and targetAdminId required' });

  try {
    const { data: user } = await supabase.from('users').select('telegram_id, username, admin_id, admin_name, invite_code').eq('telegram_id', String(telegramId)).maybeSingle();
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    const { data: targetAdmin } = await supabase.from('admins').select('id, name, invite_code').eq('id', targetAdminId).eq('is_active', true).maybeSingle();
    if (!targetAdmin) return res.status(404).json({ success: false, error: 'Target admin not found' });

    await supabase.from('users').update({
      admin_id: targetAdmin.id,
      admin_name: targetAdmin.name,
      invite_code: targetAdmin.invite_code || user.invite_code
    }).eq('telegram_id', String(telegramId));

    if (users[String(telegramId)]) {
      users[String(telegramId)].admin_id = targetAdmin.id;
      users[String(telegramId)].admin_name = targetAdmin.name;
      users[String(telegramId)]._lastFetch = Date.now();
    }

    const { data: existingTrack } = await supabase.from('invite_tracking').select('id').eq('telegram_id', String(telegramId)).order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (existingTrack) {
      await supabase.from('invite_tracking').update({
        admin_id: targetAdmin.id,
        admin_name: targetAdmin.name,
        invite_code: targetAdmin.invite_code || user.invite_code
      }).eq('id', existingTrack.id);
    } else {
      await supabase.from('invite_tracking').insert({
        telegram_id: String(telegramId),
        username: user.username,
        invite_code: targetAdmin.invite_code || user.invite_code,
        admin_id: targetAdmin.id,
        admin_name: targetAdmin.name,
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null
      });
    }

    Audit.adminAction('SUPER_ADMIN_TRANSFER_PLAYER', auth.adminId || 'secret', req.ip, {
      targetUserId: telegramId,
      fromAdminId: user.admin_id,
      toAdminId: targetAdmin.id
    });

    res.json({ success: true, message: `Player ${telegramId} transferred to ${targetAdmin.name}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/super-admin/transfer-players', async (req, res) => {
  const auth = await authSuperAdmin(req, res);
  if (!auth.success) return res.status(401).json({ error: auth.error });

  const { telegramIds, targetAdminId } = req.body;
  if (!telegramIds || !Array.isArray(telegramIds) || telegramIds.length === 0) return res.status(400).json({ error: 'telegramIds array required' });
  if (!targetAdminId) return res.status(400).json({ error: 'targetAdminId required' });

  try {
    const { data: targetAdmin } = await supabase.from('admins').select('id, name, invite_code').eq('id', targetAdminId).eq('is_active', true).maybeSingle();
    if (!targetAdmin) return res.status(404).json({ success: false, error: 'Target admin not found' });

    const { data: usersList } = await supabase.from('users').select('telegram_id, username, admin_id, admin_name, invite_code').in('telegram_id', telegramIds.map(id => String(id)));
    if (!usersList || usersList.length === 0) return res.status(404).json({ success: false, error: 'No valid players found' });

    const updatedUsers = [];
    for (const user of usersList) {
      await supabase.from('users').update({
        admin_id: targetAdmin.id,
        admin_name: targetAdmin.name,
        invite_code: targetAdmin.invite_code || user.invite_code
      }).eq('telegram_id', user.telegram_id);

      if (users[user.telegram_id]) {
        users[user.telegram_id].admin_id = targetAdmin.id;
        users[user.telegram_id].admin_name = targetAdmin.name;
        users[user.telegram_id]._lastFetch = Date.now();
      }

      const { data: existingTrack } = await supabase.from('invite_tracking').select('id').eq('telegram_id', user.telegram_id).order('created_at', { ascending: false }).limit(1).maybeSingle();

      if (existingTrack) {
        await supabase.from('invite_tracking').update({
          admin_id: targetAdmin.id,
          admin_name: targetAdmin.name,
          invite_code: targetAdmin.invite_code || user.invite_code
        }).eq('id', existingTrack.id);
      } else {
        await supabase.from('invite_tracking').insert({
          telegram_id: user.telegram_id,
          username: user.username,
          invite_code: targetAdmin.invite_code || user.invite_code,
          admin_id: targetAdmin.id,
          admin_name: targetAdmin.name,
          ip_address: req.ip || null,
          user_agent: req.headers['user-agent'] || null
        });
      }

      updatedUsers.push({ telegram_id: user.telegram_id, username: user.username });
    }

    Audit.adminAction('SUPER_ADMIN_BULK_TRANSFER_PLAYERS', auth.adminId || 'secret', req.ip, {
      targetAdminId: targetAdmin.id,
      playersTransferred: updatedUsers.length
    });

    res.json({ success: true, message: `${updatedUsers.length} player(s) transferred to ${targetAdmin.name}`, transferred: updatedUsers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/import-players', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ success: false, error: 'Session expired' }); }

  const { telegramIds, overwrite = false } = req.body;
  if (!telegramIds || !Array.isArray(telegramIds) || telegramIds.length === 0) return res.status(400).json({ success: false, error: 'At least one Telegram ID required' });

  try {
    const results = [];
    let successCount = 0;

    for (const rawId of telegramIds) {
      const identifier = String(rawId).trim();
      if (!identifier) { results.push({ telegramId: identifier, success: false, error: 'Empty identifier' }); continue; }

      let telegramId = null;
      if (/^\d+$/.test(identifier)) {
        telegramId = identifier;
      } else {
        const searchTerm = identifier.startsWith('@') ? identifier.slice(1) : identifier;
        const { data: user } = await supabase.from('users').select('telegram_id').or(`telegram_handle.ilike.${searchTerm},username.ilike.${searchTerm}`).maybeSingle();
        if (!user) { results.push({ telegramId: identifier, success: false, error: 'User not found' }); continue; }
        telegramId = user.telegram_id;
      }

      const { data: existingUser } = await supabase.from('users').select('telegram_id, admin_id').eq('telegram_id', telegramId).maybeSingle();

      if (!overwrite && existingUser && existingUser.admin_id !== null) {
        results.push({ telegramId, success: false, error: 'Already assigned (skipped)' });
        continue;
      }

      if (!existingUser) {
        const newUser = {
          telegram_id: telegramId,
          username: `Player_${telegramId.slice(-4)}`,
          balance: 10,
          invite_code: null,
          first_deposit_amount: 0,
          telegram_handle: null
        };
        const { error: insertErr } = await supabase.from('users').insert(newUser);
        if (insertErr) { results.push({ telegramId, success: false, error: insertErr.message }); continue; }

        users[telegramId] = {
          id: telegramId,
          username: newUser.username,
          balance: newUser.balance,
          telegram_handle: null,
          invite_code: null,
          first_deposit_amount: 0,
          admin_id: null,
          admin_name: null,
          _lastFetch: Date.now()
        };
        results.push({ telegramId, success: true, created: true });
        successCount++;
      } else {
        results.push({ telegramId, success: true, updated: false, message: 'User already exists' });
      }
    }

    Audit.adminAction('IMPORT_PLAYERS', req.session.adminId, req.ip, { count: telegramIds.length, successCount, overwrite });
    res.json({ success: true, message: `Imported ${successCount} player(s)`, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/stats-summary', async (req, res) => {
  const { secret, from, to } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    let depositQuery = supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    let withdrawalQuery = supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    let roundsQuery = supabase.from('game_rounds').select('house_profit');

    if (from) {
      const fromDate = new Date(from); fromDate.setHours(0, 0, 0, 0);
      depositQuery = depositQuery.gte('created_at', fromDate.toISOString());
      withdrawalQuery = withdrawalQuery.gte('created_at', fromDate.toISOString());
      roundsQuery = roundsQuery.gte('created_at', fromDate.toISOString());
    }
    if (to) {
      const toDate = new Date(to); toDate.setHours(23, 59, 59, 999);
      depositQuery = depositQuery.lte('created_at', toDate.toISOString());
      withdrawalQuery = withdrawalQuery.lte('created_at', toDate.toISOString());
      roundsQuery = roundsQuery.lte('created_at', toDate.toISOString());
    }

    const { data: deposits } = await depositQuery;
    const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);
    const { data: withdrawals } = await withdrawalQuery;
    const totalWithdrawals = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
    const { data: rounds } = await roundsQuery;
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);

    res.json({ success: true, totalDeposits, totalWithdrawals, totalHouseProfit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    const { data: deposits } = await supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    const { data: withdrawals } = await supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    const { data: rounds } = await supabase.from('game_rounds').select('house_profit');
    const totalDeposits = deposits.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalWithdrawals = withdrawals.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);
    res.json({ success: true, totalDeposits, totalWithdrawals, totalHouseProfit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/link-stats', async (req, res) => {
  const admin = await getAdminFromSession(req);
  if (!admin) { req.session.destroy(); return res.status(401).json({ error: 'Session expired' }); }

  try {
    const { data: opens } = await supabase
      .from('admin_link_opens')
      .select('*')
      .eq('admin_id', admin.id)
      .order('created_at', { ascending: false })
      .limit(100);

    const totalOpens = opens.length;
    const uniqueUsers = new Set(opens.map(o => o.user_id).filter(Boolean)).size;

    res.json({ success: true, stats: { totalOpens, uniqueUsers }, recentOpens: opens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  TELEGRAM BOT
// ================================================================
const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  console.warn('⚠️ BOT_TOKEN is not set – Telegram bot disabled');
} else {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(botToken, { polling: true });
    console.log('🤖 Telegram bot started (polling)');

    bot.onText(/\/start(.+)?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const startParam = match[1] ? match[1].trim() : '';
      const webAppUrl = process.env.APP_URL || 'https://new-g-production-e478.up.railway.app';
      const webAppUrlWithParam = startParam ? `${webAppUrl}?start_param=${startParam}` : webAppUrl;

      if (startParam) {
        const userId = msg.from.id.toString();
        const username = msg.from.username || msg.from.first_name || 'Unknown';

        let adminId = null;
        let adminName = null;
        try {
          const { data: admin } = await supabase
            .from('admins')
            .select('id, name')
            .eq('invite_code', startParam)
            .eq('is_active', true)
            .maybeSingle();
          if (admin) { adminId = admin.id; adminName = admin.name; }
        } catch (e) { console.error('Error looking up admin:', e.message); }

        try {
          const { data: existing } = await supabase
            .from('invite_tracking')
            .select('id')
            .eq('telegram_id', userId)
            .eq('invite_code', startParam)
            .maybeSingle();

          if (existing) {
            await supabase.from('invite_tracking').update({
              username, admin_id: adminId, admin_name: adminName, user_agent: 'telegram_bot'
            }).eq('id', existing.id);
          } else {
            await supabase.from('invite_tracking').insert({
              telegram_id: userId,
              username,
              invite_code: startParam,
              admin_id: adminId,
              admin_name: adminName,
              ip_address: null,
              user_agent: 'telegram_bot'
            });
          }
        } catch (e) { console.error('Error with invite_tracking:', e.message); }

        try {
          const { data: user } = await supabase.from('users').select('id, admin_id').eq('telegram_id', userId).maybeSingle();
          if (user) {
            const updates = { invite_code: startParam };
            if (adminId && !user.admin_id) {
              updates.admin_id = adminId;
              updates.admin_name = adminName;
            }
            await supabase.from('users').update(updates).eq('telegram_id', userId);
          }
        } catch (e) { console.error('Error updating users table:', e.message); }
      }

      const messageText = startParam
        ? `🎯 Welcome! You are using invite code: ${startParam}\nClick below to open the game.`
        : '🎯 Welcome! Click below to start playing.';

      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Open Game', web_app: { url: webAppUrlWithParam } }]
          ]
        }
      };

      bot.sendMessage(chatId, messageText, options)
        .then(() => console.log(`✅ Sent web_app button to ${chatId}`))
        .catch(err => console.error(`❌ Failed to send message:`, err.message));
    });

    bot.on('polling_error', (err) => console.error('Polling error:', err.message));
  } catch (err) {
    console.error('❌ Failed to initialize Telegram bot:', err.message);
  }
}

// ================================================================
//  SOCKET.IO — MAIN NAMESPACE (with socket map)
// ================================================================
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  socketByUser.set(String(socket.userId), socket);
  socket.on('disconnect', () => {
    if (socketByUser.get(String(socket.userId)) === socket) {
      socketByUser.delete(String(socket.userId));
    }
  });

  let currentStake = null;
  socket.emit('balanceUpdate', users[socket.userId]?.balance || 0);

  for (const stake of [10, 20, 30]) {
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });
  }

  socket.on('joinLobby', ({ stake }) => {
    if (![10, 20, 30].includes(stake)) return;
    currentStake = stake;
    socket.join(`stake_${stake}`);
    const game = getGame(stake);
    socket.emit('playersCount', { stake, count: game.players.length });

    if (game.status === 'lobby') {
      const timeLeft = Math.max(0, Math.ceil((game.lobbyEndTime - Date.now()) / 1000));
      socket.emit('lobbyState', {
        stake,
        startsIn: timeLeft,
        takenNumbers: Array.from(game.takenCardNumbers),
        playersCount: game.players.length
      });
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
    if (existing) {
      game.takenCardNumbers.delete(existing.cardNumber);
      game.players = game.players.filter(p => p.telegramId !== socket.userId);
    }
    game.takenCardNumbers.add(num);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      telegramId: socket.userId,
      username: socket.username,
      card: game.cardSet[num - 1],
      markedNumbers: [],
      cardNumber: num,
      ip
    };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: num.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', {
      stake: currentStake,
      number: num,
      takenNumbers: Array.from(game.takenCardNumbers)
    });
    broadcastPlayerCount(currentStake);
    socket.emit('yourCard', player.card);
    notifyAdminClients();
  });

  socket.on('newCardNumber', () => {
    if (!currentStake) return;
    const game = getGame(currentStake);
    if (game.status !== 'lobby') return;
    const userBalance = users[socket.userId]?.balance || 0;
    if (userBalance < game.entryFee) { socket.emit('cardSelectionFailed', `Insufficient balance. Need ${game.entryFee} birr.`); return; }

    const freeNumbers = [];
    for (let i = 1; i <= 100; i++) if (!game.takenCardNumbers.has(i)) freeNumbers.push(i);
    if (freeNumbers.length === 0) { socket.emit('cardSelectionFailed', 'All numbers are taken.'); return; }

    const randomNum = freeNumbers[Math.floor(Math.random() * freeNumbers.length)];
    const existing = game.players.find(p => p.telegramId === socket.userId);
    if (existing) {
      game.takenCardNumbers.delete(existing.cardNumber);
      game.players = game.players.filter(p => p.telegramId !== socket.userId);
    }
    game.takenCardNumbers.add(randomNum);
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const player = {
      telegramId: socket.userId,
      username: socket.username,
      card: game.cardSet[randomNum - 1],
      markedNumbers: [],
      cardNumber: randomNum,
      ip
    };
    game.players.push(player);
    Audit.cardAssigned(`stake_${currentStake}`, socket.userId, ip, { cardId: randomNum.toString(), grid: player.card });
    io.to(`stake_${currentStake}`).emit('cardTaken', {
      stake: currentStake,
      number: randomNum,
      takenNumbers: Array.from(game.takenCardNumbers)
    });
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

// ================================================================
//  ADMIN NAMESPACE
// ================================================================
const adminNamespace = io.of('/admin');
adminNamespace.use((socket, next) => {
  const secret = socket.handshake.query.secret;
  if (secret === process.env.ADMIN_SECRET) return next();
  next(new Error('Unauthorized admin access'));
});

adminNamespace.on('connection', (socket) => {
  socket.emit('admin:playersList', buildAdminSnapshot());

  // ★ NEW ★ send current winners history immediately on connect
  socket.emit('admin:winnerHistory', roundWinnersHistory);

  // ★ NEW ★ handle explicit request from client
  socket.on('admin:getWinners', () => {
    socket.emit('admin:winnerHistory', roundWinnersHistory);
  });

  socket.on('admin:requestPlayers', () => {
    socket.emit('admin:playersList', buildAdminSnapshot());
  });

  socket.on('admin:getAllRegisteredPlayers', async () => {
    try {
      const { data: allUsers, error } = await supabase
        .from('users')
        .select('telegram_id, username, balance, telegram_handle, invite_code, first_deposit_amount, admin_id, admin_name');
      if (error) throw error;
      const usersList = (allUsers || []).map(u => ({
        telegramId: u.telegram_id,
        username: u.username,
        balance: u.balance,
        telegram_handle: u.telegram_handle,
        invite_code: u.invite_code,
        first_deposit_amount: u.first_deposit_amount || 0,
        admin_id: u.admin_id,
        admin_name: u.admin_name
      }));
      socket.emit('admin:allRegisteredPlayers', { users: usersList });
    } catch (err) {
      console.error('Failed to fetch all registered users:', err);
      socket.emit('admin:allRegisteredPlayers', { users: [] });
    }
  });
});

// ================================================================
//  ERROR HANDLER
// ================================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ================================================================
//  GRACEFUL SHUTDOWN
// ================================================================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try { await snapshotManager.saveAll(); } catch (e) { console.error(e); }
  try { await writeQueue.flush(); } catch (e) { console.error(e); }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.warn('Forced exit after 10s');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ================================================================
//  BOOT — recovery first, then start game loops
// ================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Bingo server on port ${PORT}`);

  await snapshotManager.recoverOnBoot();

  resetGame(10);
  resetGame(20);
  resetGame(30);
});
