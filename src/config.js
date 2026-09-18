require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Optional subpath mount, e.g. BASE_PATH=otp  ->  https://domain/otp/app/dashboard
  // Blank means the app serves at the domain root.
  basePath: (process.env.BASE_PATH || '').replace(/^\/+|\/+$/g, ''),
  // DB mode: 'supabase' when SUPABASE_URL & key provided, else 'sqlite' (local fallback)
  dbMode: process.env.DB_MODE
    ? process.env.DB_MODE.toLowerCase()
    : process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? 'supabase'
      : 'sqlite',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'otp-software-secret-change-me',
  // Short-lived access token (JWT). '6h' default.
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES || '6h',
  // Legacy alias kept for compatibility.
  jwtExpires: process.env.JWT_EXPIRES || '1d',
  // How long a refresh session lasts, in days (sliding on refresh).
  sessionDays: parseInt(process.env.SESSION_DAYS || '30', 10),
  sessionMaxDevices: parseInt(process.env.SESSION_MAX_DEVICES || '10', 10),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@site.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  // order can be cancelled while pending (no OTP). Auto-expire after this long.
  otpExpireMs: (parseInt(process.env.OTP_EXPIRE_MINUTES || '10', 10)) * 60 * 1000,
  // how often we poll each pending order's SMS api_url
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  // rate limiting (per window per key) — tunable via env
  rateLimit: {
    login:      { windowMs: 5 * 60 * 1000,   max: parseInt(process.env.RL_LOGIN_MAX || '10', 10) },
    register:   { windowMs: 15 * 60 * 1000,  max: parseInt(process.env.RL_REGISTER_MAX || '5', 10) },
    apiV1:      { windowMs: 60 * 1000,       max: parseInt(process.env.RL_API_MAX || '240', 10) },
    purchase:   { windowMs: 60 * 1000,       max: parseInt(process.env.RL_BUY_MAX || '30', 10) },
    otpPoll:    { windowMs: 60 * 1000,       max: parseInt(process.env.RL_OTP_MAX || '120', 10) },
    cancel:     { windowMs: 60 * 1000,       max: parseInt(process.env.RL_CANCEL_MAX || '30', 10) },
    topup:      { windowMs: 60 * 1000,       max: parseInt(process.env.RL_TOPUP_MAX || '10', 10) },
    keyGen:     { windowMs: 60 * 60 * 1000,  max: parseInt(process.env.RL_KEYGEN_MAX || '5', 10) },
    ticketMsg:  { windowMs: 60 * 1000,       max: parseInt(process.env.RL_TICKET_MAX || '10', 10) },
    admin:      { windowMs: 60 * 1000,       max: parseInt(process.env.RL_ADMIN_MAX || '300', 10) },
  },
  sqliteFile: process.env.SQLITE_FILE || require('path').join(__dirname, '..', 'data', 'otp-software.db'),
};

module.exports = config;