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

