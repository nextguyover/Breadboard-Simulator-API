import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { AuthGuard, RateLimiter } from './ratelimit.js';
import { validatePatch, validateReport, STATUSES } from './validate.js';

const ADMIN_HTML = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

class HttpError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest();

export function createApp(cfg, db = openDb(cfg.dbPath)) {
  const limiter = new RateLimiter(cfg);
  const authGuard = new AuthGuard({ authFailMax: 5, authFailWindowMs: 900_000, authLockoutMs: 3_600_000, ...cfg });
  const adminTokenHash = sha256(cfg.adminToken);
  const adminHtml = ADMIN_HTML.replace('__APP_URL__', JSON.stringify(cfg.appUrl).replace(/</g, '\\u003c'));

  function clientIp(req) {
    if (cfg.trustCloudflare) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf) return cf.trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function ipHash(ip) {
    return createHash('sha256').update(cfg.ipHashSalt).update(ip).digest('hex').slice(0, 16);
  }

  function requireAdmin(req) {
    const ip = clientIp(req);
    const locked = authGuard.lockedFor(ip);
    if (locked) throw tooManyAuthFailures(locked);
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'unauthorized', 'Missing or wrong admin token');
    if (!timingSafeEqual(sha256(m[1]), adminTokenHash)) {
      const lockout = authGuard.fail(ip);
      if (lockout) {
        console.warn(`admin login: too many wrong tokens from ${ipHash(ip)}, locked out for ${lockout} s`);
        throw tooManyAuthFailures(lockout);
      }
      throw new HttpError(401, 'unauthorized', 'Missing or wrong admin token');
    }
    authGuard.succeed(ip);
  }

  function tooManyAuthFailures(retryAfter) {
    return Object.assign(
      new HttpError(429, 'too_many_auth_failures', 'Too many wrong admin tokens from this address, try again later', { retryAfter }),
      { headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!cfg.allowedOrigins.includes(origin)) {
      throw new HttpError(403, 'origin_not_allowed', 'This origin may not submit reports');
    }
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }

  async function readJson(req) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    const declared = Number(req.headers['content-length']);
    if (declared > cfg.maxBodyBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cfg.maxBodyBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
    }
  }

  function reportId(raw) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, 'not_found', 'No such report');
    return id;
  }

  function validationError(result) {
    if (result.invalidJson) return new HttpError(400, 'invalid_json', 'Body must be a JSON object');
    if (result.tooLarge) return new HttpError(413, 'payload_too_large', 'Screenshot is too large', { fields: result.fields });
    return new HttpError(400, 'validation_failed', 'Some fields are invalid', { fields: result.fields });
  }

  async function submitReport(req, res) {
    const cors = corsHeaders(req);
    try {
      return await acceptReport(req, res, cors);
    } catch (err) {
      // The browser can only read an error response that carries the CORS headers.
      if (err instanceof HttpError) err.headers = { ...cors, ...err.headers };
      throw err;
    }
  }

  async function acceptReport(req, res, cors) {
    const body = await readJson(req);
    const result = validateReport(body, cfg);
    if (!result.ok) throw validationError(result);

    const ip = clientIp(req);
    const limited = limiter.take(ip);
    if (limited) {
      throw Object.assign(
        new HttpError(limited.error === 'daily_limit_reached' ? 503 : 429, limited.error,
          'Too many reports right now, please try again later', { retryAfter: limited.retryAfter }),
        { headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const r = result.value;
    if (r.honeypot) {
      // Pretend it worked so bots don't learn to skip the field.
      return send(res, 201, { id: 0, createdAt: new Date().toISOString() }, cors);
    }
    const saved = db.insert({
      ...r,
      userAgent: r.userAgent ?? ((req.headers['user-agent'] || '').slice(0, 512) || undefined),
      ipHash: ipHash(ip),
    });
    return send(res, 201, saved, cors);
  }

  function recordLaunch(req) {
    try {
      const ip = clientIp(req);
      const ua = (req.headers['user-agent'] || '').slice(0, 512);
      const cf = (name) => {
        const v = cfg.trustCloudflare ? req.headers[name] : undefined;
        // Node reads header bytes as latin1; Cloudflare sends UTF-8 (e.g. "München").
        return typeof v === 'string' && v ? Buffer.from(v, 'latin1').toString('utf8').slice(0, 100) : undefined;
      };
      const country = cf('cf-ipcountry')?.toUpperCase();
      db.analytics.record({
        visitor: ipHash(`${ip}|${ua}`),
        country: country && /^[A-Z0-9]{2}$/.test(country) ? country : 'XX',
        region: cf('cf-region'),
        city: cf('cf-ipcity'),
        userAgent: ua,
        // Added by a Cloudflare Request Header Transform Rule (see docs/API.md).
        asn: /^[1-9]\d{0,9}$/.test(cf('x-bsim-asn') ?? '') ? Number(cf('x-bsim-asn')) : undefined,
        bot: cf('x-bsim-verified-bot') === 'true',
      });
    } catch (err) {
      console.error('could not record launch', err);
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      // Allowed app origins may read it, so the app can hide "Report a bug" while the service is down.
      const origin = req.headers.origin;
      const fromApp = !!origin && cfg.allowedOrigins.includes(origin);
      const cors = fromApp ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
      // The app pings once per launch, so each ping from the app counts as a launch. Monitoring
      // and install checks send no Origin, and the app marks repeat checks with ?recheck=1.
      if (fromApp && method === 'GET' && !url.searchParams.has('recheck')) recordLaunch(req);
      return send(res, 200, { ok: true }, cors);
    }

    if ((path === '/v1/analytics' || path === '/v1/analytics/visitors') && method === 'GET') {
      requireAdmin(req);
      const num = (name, fallback) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : fallback);
      const days = num('days', 30);
      const tzMinutes = num('tz', 0);
      const limit = num('limit', 50);
      const offset = num('offset', 0);
      if (!Number.isInteger(days) || days < 0 || days > 3660 || !Number.isInteger(tzMinutes) || Math.abs(tzMinutes) > 900
        || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
        throw new HttpError(400, 'validation_failed', 'Bad query', {
          fields: { days: '0 to 3660', tz: '-900 to 900', limit: '1 to 200', offset: '0 or more' },
        });
      }
      const hideDatacenter = url.searchParams.get('hideDatacenter') === '1';
      if (path === '/v1/analytics/visitors') {
        return send(res, 200, { days, ...db.analytics.visitors({ days, hideDatacenter, limit, offset }) });
      }
      return send(res, 200, { days, ...db.analytics.summary({ days, tzMinutes, hideDatacenter }) });
    }

    const vm = /^\/v1\/analytics\/visitors\/([0-9a-f]{16})$/.exec(path);
    if (vm && method === 'GET') {
      requireAdmin(req);
      const visitor = db.analytics.visitor(vm[1]);
      if (!visitor) throw new HttpError(404, 'not_found', 'No such visitor');
      return send(res, 200, visitor);
    }

    if (path === '/admin' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
        ...COMMON_HEADERS,
      });
      return res.end(adminHtml);
    }

    if (path === '/v1/reports') {
      if (method === 'OPTIONS') {
        const cors = corsHeaders(req);
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          ...COMMON_HEADERS,
        });
        return res.end();
      }
      if (method === 'POST') return submitReport(req, res);
      if (method === 'GET') {
        requireAdmin(req);
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new HttpError(400, 'validation_failed', 'Bad query', { fields: { limit: 'must be 1 to 200' } });
        }
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
        if (before !== undefined && !Number.isSafeInteger(before)) {
          throw new HttpError(400, 'validation_failed', 'Bad query', { fields: { before: 'must be an integer' } });
        }
        const status = url.searchParams.get('status') || undefined;
        if (status && !STATUSES.includes(status)) {
          throw new HttpError(400, 'validation_failed', 'Bad query', { fields: { status: `must be one of ${STATUSES.join(', ')}` } });
        }
        return send(res, 200, { ...db.list({ limit, before, status }), counts: db.counts() });
      }
      throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    }

    let m = /^\/v1\/reports\/([^/]+)$/.exec(path);
    if (m) {
      requireAdmin(req);
      const id = reportId(m[1]);
      if (method === 'GET') {
        const report = db.get(id);
        if (!report) throw new HttpError(404, 'not_found', 'No such report');
        return send(res, 200, report);
      }
      if (method === 'PATCH') {
        const result = validatePatch(await readJson(req));
        if (!result.ok) throw validationError(result);
        const report = db.update(id, result.value);
        if (!report) throw new HttpError(404, 'not_found', 'No such report');
        return send(res, 200, report);
      }
      if (method === 'DELETE') {
        if (!db.delete(id)) throw new HttpError(404, 'not_found', 'No such report');
        res.writeHead(204, COMMON_HEADERS);
        return res.end();
      }
      throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    }

    m = /^\/v1\/reports\/([^/]+)\/screenshot$/.exec(path);
    if (m && method === 'GET') {
      requireAdmin(req);
      const shot = db.screenshot(reportId(m[1]));
      if (!shot) throw new HttpError(404, 'not_found', 'This report has no screenshot');
      res.writeHead(200, { 'Content-Type': shot.mime, 'Content-Length': shot.bytes.length, ...COMMON_HEADERS });
      return res.end(shot.bytes);
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.error, message: err.message, ...err.extra }, err.headers);
        // Stop reading an oversized upload instead of draining it.
        if (err.status === 413) res.once('finish', () => req.destroy());
      } else {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'internal_error', message: 'Something went wrong' });
        else res.destroy();
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, db };
}

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...COMMON_HEADERS,
    ...headers,
  });
  res.end(json);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const { server, db } = createApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`breadboard-simulator-api listening on http://${cfg.host}:${cfg.port}`);
    console.log(`allowed origins: ${cfg.allowedOrigins.join(', ')}; trust Cloudflare IP header: ${cfg.trustCloudflare}`);
  });
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
