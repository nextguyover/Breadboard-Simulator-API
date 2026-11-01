// All settings come from environment variables (see deploy/breadboard-simulator-api.env.example).

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const cfg = {
    host: process.env.HOST || '127.0.0.1',
    port: int('PORT', 8787),
    dbPath: process.env.DB_PATH || './data/reports.db',
    adminToken: process.env.ADMIN_TOKEN || '',
    ipHashSalt: process.env.IP_HASH_SALT || '',
    trustCloudflare: process.env.TRUST_CLOUDFLARE === '1',
    allowedOrigins: list('ALLOWED_ORIGINS', ['https://app.breadboardsimulator.com']),
    appUrl: process.env.APP_URL || 'https://app.breadboardsimulator.com/',

    // Rate limits for POST /v1/reports. Global limits are off (0) by default; per-IP limits do the work.
    perIpWindowMs: int('RATE_PER_IP_WINDOW_SEC', 600) * 1000,
    perIpWindowMax: int('RATE_PER_IP_WINDOW_MAX', 5),
    perIpDailyMax: int('RATE_PER_IP_DAILY_MAX', 20),

    // Wrong admin tokens: after AUTH_FAIL_MAX within the window, the IP is locked out.
    authFailMax: int('AUTH_FAIL_MAX', 5),
    authFailWindowMs: int('AUTH_FAIL_WINDOW_SEC', 900) * 1000,
    authLockoutMs: int('AUTH_LOCKOUT_SEC', 3600) * 1000,
    globalPerSec: int('RATE_GLOBAL_PER_SEC', 0),
    globalBurst: int('RATE_GLOBAL_BURST', 10),
    globalDailyMax: int('RATE_GLOBAL_DAILY_MAX', 0),

    // Size limits.
    maxBodyBytes: int('MAX_BODY_BYTES', 3 * 1024 * 1024),
    maxScreenshotBytes: int('MAX_SCREENSHOT_BYTES', 2 * 1024 * 1024),
    ...overrides,
  };

  if (cfg.adminToken.length < 24) {
    throw new Error('ADMIN_TOKEN must be set and at least 24 characters (try: openssl rand -hex 32)');
  }
  if (cfg.ipHashSalt.length < 16) {
    throw new Error('IP_HASH_SALT must be set and at least 16 characters (try: openssl rand -hex 32)');
  }
  return cfg;
}
