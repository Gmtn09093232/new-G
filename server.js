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

// ---------- Audit Logger (unchanged) ----------
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
    telebirr: {
      phone: process.env.ADMIN_PHONE || '0924839730',
      ussd: process.env.TELEBIRR_USSD || '*127#'
    },
    cbebirr: {
      phone: process.env.CBE_ACCOUNT || '1000123456789',
      ussd: process.env.CBEBIRR_USSD || '*127#'  // change if CBE has its own USSD
    },
    mpesa: {
      phone: process.env.MPESA_ACCOUNT || '251912345678',
      ussd: process.env.MPESA_USSD || '*127#'    // change if M-Pesa has its own
    }
  });
});

// (Optional) separate endpoint for just USSD codes
app.get('/api/ussd-codes', (req, res) => {
  res.json({
    telebirr: process.env.TELEBIRR_USSD || '*127#',
    cbebirr: process.env.CBEBIRR_USSD || '*127#',
    mpesa: process.env.MPESA_USSD || '*127#'
  });
});

app.get('/api/admin-phone', (req, res) => { res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }); });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'live.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/users', (req, res) => res.sendFile(path.join(__dirname, 'users.html')));
app.get('/invite-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'invite-dashboard.html'))); // referral dashboard

app.get('/admin/live-players', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).send('Forbidden: invalid or missing admin secret');
  }
  res.sendFile(path.join(__dirname, 'admin-live-players.html'));
});

// ---------- [REST OF THE CODE REMAINS UNCHANGED] ----------
// ... (all other functions: loadUser, verifyTelegram, admin endpoints, socket.io, etc.)
// The rest of the server code is exactly as provided; we only changed the deposit-accounts endpoint and added the ussd-codes endpoint.
// Ensure you also add the new environment variables to your .env file:
//
// TELEBIRR_USSD=*127#
// CBEBIRR_USSD=*127#     (or whatever code CBE uses)
// MPESA_USSD=*127#       (or whatever code M-Pesa uses)
//
// The frontend should now read the ussd field from /api/deposit-accounts and use it for the auto-dial overlay.

// ---------- (continues with existing code) ----------
