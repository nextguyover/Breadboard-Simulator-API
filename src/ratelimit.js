// In-memory rate limiting for POST /v1/reports. State resets on restart, which is fine for a
// spam guard. Per-IP limits run first so one sender can't drain the global budget for everyone.

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(now) {
  return Math.floor(now / DAY_MS);
}

export class RateLimiter {
  constructor(cfg, now = () => Date.now()) {
    this.cfg = cfg;
    this.now = now;
    this.perIp = new Map(); // ip key -> { hits: timestamps in the current window, dayCount }
    this.tokens = cfg.globalBurst;
    this.lastRefill = now();
    this.day = utcDay(now());
    this.dayCount = 0;
  }

  // Returns null and records the hit when allowed, or { error, retryAfter } (seconds) when not.
  take(key) {
    const t = this.now();
    const c = this.cfg;
    const day = utcDay(t);

    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
      this.perIp.clear();
    }

    // Entries are only created for accepted reports, so the map is bounded by the global daily cap.
    const ip = this.perIp.get(key) || { hits: [], dayCount: 0 };
    ip.hits = ip.hits.filter((h) => t - h < c.perIpWindowMs);

    const untilTomorrow = Math.ceil(((day + 1) * DAY_MS - t) / 1000);

    if (c.perIpDailyMax > 0 && ip.dayCount >= c.perIpDailyMax) {
      return { error: 'rate_limited', retryAfter: untilTomorrow };
    }
    if (c.perIpWindowMax > 0 && ip.hits.length >= c.perIpWindowMax) {
      return { error: 'rate_limited', retryAfter: Math.max(1, Math.ceil((ip.hits[0] + c.perIpWindowMs - t) / 1000)) };
    }

    if (c.globalPerSec > 0) {
      this.tokens = Math.min(c.globalBurst, this.tokens + ((t - this.lastRefill) / 1000) * c.globalPerSec);
      this.lastRefill = t;
      if (this.tokens < 1) {
        return { error: 'rate_limited', retryAfter: Math.max(1, Math.ceil((1 - this.tokens) / c.globalPerSec)) };
      }
    }
    if (c.globalDailyMax > 0 && this.dayCount >= c.globalDailyMax) {
      return { error: 'daily_limit_reached', retryAfter: untilTomorrow };
    }

    if (c.globalPerSec > 0) this.tokens -= 1;
    this.dayCount += 1;
    ip.hits.push(t);
    ip.dayCount += 1;
    this.perIp.set(key, ip);
    return null;
  }
}


// Locks an IP out of the admin endpoints after too many wrong tokens, so the token can't be
// brute-forced. While locked out even the right token is refused.
export class AuthGuard {
  constructor({ authFailMax, authFailWindowMs, authLockoutMs }, now = () => Date.now()) {
    this.max = authFailMax;
    this.windowMs = authFailWindowMs;
    this.lockoutMs = authLockoutMs;
    this.now = now;
    this.byIp = new Map(); // ip key -> { fails: timestamps in the window, lockedUntil }
  }

  // Seconds until this IP may try again, or 0 when it isn't locked out.
  lockedFor(key) {
    const e = this.byIp.get(key);
    if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - this.now();
    if (left > 0) return Math.ceil(left / 1000);
    this.byIp.delete(key);
    return 0;
  }

  // Records a wrong token. Returns the lockout in seconds if this attempt triggered one.
  fail(key) {
    const t = this.now();
    if (this.byIp.size > 10_000) this.prune(t);
    const e = this.byIp.get(key) || { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((f) => t - f < this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.max) {
      e.fails = [];
      e.lockedUntil = t + this.lockoutMs;
    }
    this.byIp.set(key, e);
    return e.lockedUntil > t ? Math.ceil(this.lockoutMs / 1000) : 0;
  }

  succeed(key) {
    this.byIp.delete(key);
  }

  prune(t) {
    for (const [key, e] of this.byIp) {
      if (e.lockedUntil <= t && e.fails.every((f) => t - f >= this.windowMs)) this.byIp.delete(key);
    }
  }
}
