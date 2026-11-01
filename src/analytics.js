// App launch analytics. The app pings /healthz once on load; each ping from an allowed app origin
// is logged here as one launch. Location comes from Cloudflare's visitor headers, so no GeoIP
// database is needed and raw IPs are never stored.

const DEDUPE_MS = 10_000; // a second ping from the same visitor within this window is not a new launch

// Well-known cloud and hosting networks. Launches from these are almost always bots or scrapers.
export const DATACENTER_ASNS = new Map([
  [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [8987, 'Amazon AWS'],
  [15169, 'Google'], [396982, 'Google Cloud'], [19527, 'Google'],
  [8075, 'Microsoft Azure'], [8068, 'Microsoft'],
  [31898, 'Oracle Cloud'], [14061, 'DigitalOcean'], [24940, 'Hetzner'], [213230, 'Hetzner Cloud'],
  [16276, 'OVH'], [63949, 'Akamai / Linode'], [20473, 'Vultr'], [51167, 'Contabo'], [12876, 'Scaleway'],
  [60781, 'Leaseweb'], [28753, 'Leaseweb'], [13335, 'Cloudflare'], [209242, 'Cloudflare WARP'],
  [45102, 'Alibaba Cloud'], [37963, 'Alibaba Cloud'], [132203, 'Tencent Cloud'], [45090, 'Tencent Cloud'],
  [47583, 'Hostinger'], [8560, 'IONOS'], [9009, 'M247'], [212238, 'Datacamp'], [62240, 'Clouvider'],
  [174, 'Cogent'], [36352, 'ColoCrossing'], [55286, 'B2 Net'], [46606, 'Unified Layer'],
]);
const DC_LIST = [...DATACENTER_ASNS.keys()].join(',');

export function setupAnalytics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS launches (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,
      visitor TEXT NOT NULL,
      country TEXT NOT NULL,
      region  TEXT,
      city    TEXT,
      browser TEXT NOT NULL,
      os      TEXT NOT NULL,
      device  TEXT NOT NULL,
      asn     INTEGER,
      bot     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS launches_ts ON launches (ts);
    CREATE INDEX IF NOT EXISTS launches_visitor ON launches (visitor, ts);
  `);
  // Databases from before the bot/network columns existed.
  const cols = new Set(db.prepare('PRAGMA table_info(launches)').all().map((c) => c.name));
  if (!cols.has('asn')) db.exec('ALTER TABLE launches ADD COLUMN asn INTEGER');
  if (!cols.has('bot')) db.exec('ALTER TABLE launches ADD COLUMN bot INTEGER NOT NULL DEFAULT 0');

  const recent = db.prepare('SELECT 1 FROM launches WHERE visitor = ? AND ts > ? LIMIT 1');
  const insert = db.prepare(`
    INSERT INTO launches (ts, visitor, country, region, city, browser, os, device, asn, bot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    record({ visitor, country, region, city, userAgent, asn, bot }, now = new Date()) {
      if (recent.get(visitor, new Date(now.getTime() - DEDUPE_MS).toISOString())) return false;
      const ua = parseUserAgent(userAgent);
      insert.run(now.toISOString(), visitor, country, region ?? null, city ?? null, ua.browser, ua.os, ua.device,
        asn ?? null, bot ? 1 : 0);
      return true;
    },

    // days: how far back (0 = everything). tzMinutes: viewer's UTC offset, so days match their calendar.
    // Verified bots are never counted; hideDatacenter also drops launches from cloud/hosting networks.
    summary({ days, tzMinutes, hideDatacenter = false }) {
      const shift = `${tzMinutes >= 0 ? '+' : '-'}${Math.abs(tzMinutes)} minutes`;
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
      const dc = `asn IN (${DC_LIST})`;
      const where = `WHERE ts >= ? AND bot = 0${hideDatacenter ? ` AND (asn IS NULL OR NOT ${dc})` : ''}`;
      const one = (sql) => db.prepare(sql).get(since);
      const all = (sql) => db.prepare(sql).all(since);
      const group = (col, limit) => all(`
        SELECT ${col} AS key, COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors
        FROM launches ${where} GROUP BY ${col} ORDER BY launches DESC, key LIMIT ${limit}`);

      const totals = one(`SELECT COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors FROM launches ${where}`);
      const returning = one(`
        SELECT COUNT(*) AS n FROM (
          SELECT visitor FROM launches ${where} GROUP BY visitor HAVING COUNT(DISTINCT date(ts, '${shift}')) > 1)`).n;
      const excluded = one(`
        SELECT SUM(bot) AS bots, SUM(bot = 0 AND ${dc}) AS datacenter, SUM(asn IS NOT NULL) AS withAsn
        FROM launches WHERE ts >= ?`);
      return {
        totals: {
          ...totals,
          returningVisitors: returning,
          verifiedBots: excluded.bots ?? 0,
          datacenter: excluded.datacenter ?? 0,
          withNetwork: excluded.withAsn ?? 0,
        },
        hideDatacenter,
        daily: all(`
          SELECT date(ts, '${shift}') AS day, COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors
          FROM launches ${where} GROUP BY day ORDER BY day`),
        hours: all(`
          SELECT CAST(strftime('%H', ts, '${shift}') AS INTEGER) AS hour, COUNT(*) AS launches
          FROM launches ${where} GROUP BY hour ORDER BY hour`),
        countries: group('country', 300),
        cities: all(`
          SELECT country, region, city, COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors
          FROM launches ${where} AND city IS NOT NULL GROUP BY country, region, city ORDER BY launches DESC LIMIT 50`),
        browsers: group('browser', 20),
        os: group('os', 20),
        devices: group('device', 5),
        networks: all(`
          SELECT asn, COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors
          FROM launches ${where} AND asn IS NOT NULL GROUP BY asn ORDER BY launches DESC, asn LIMIT 30`)
          .map((r) => ({ ...r, name: DATACENTER_ASNS.get(r.asn) ?? null, datacenter: DATACENTER_ASNS.has(r.asn) })),
        firstLaunch: one(`SELECT MIN(ts) AS ts FROM launches ${where}`).ts,
      };
    },

    // Visitors seen in the range, most recent first, with what their latest launch looked like.
    visitors({ days, hideDatacenter = false, limit = 50, offset = 0 }) {
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
      const dc = `asn IN (${DC_LIST})`;
      const where = `WHERE ts >= ? AND bot = 0${hideDatacenter ? ` AND (asn IS NULL OR NOT ${dc})` : ''}`;
      const total = db.prepare(`SELECT COUNT(DISTINCT visitor) AS n FROM launches ${where}`).get(since).n;
      const rows = db.prepare(`
        WITH v AS (
          SELECT visitor, COUNT(*) AS launches, MIN(ts) AS firstSeen, MAX(ts) AS lastSeen, MAX(id) AS lastId
          FROM launches ${where} GROUP BY visitor)
        SELECT v.visitor, v.launches, v.firstSeen, v.lastSeen,
               l.country, l.region, l.city, l.browser, l.os, l.device, l.asn,
               (SELECT COUNT(*) FROM launches a WHERE a.visitor = v.visitor AND a.bot = 0) AS allTimeLaunches,
               (SELECT MIN(ts) FROM launches a WHERE a.visitor = v.visitor AND a.bot = 0) AS allTimeFirstSeen
        FROM v JOIN launches l ON l.id = v.lastId
        ORDER BY v.lastSeen DESC LIMIT ? OFFSET ?`).all(since, limit, offset);
      return { total, visitors: rows.map(withNetwork) };
    },

    // Every launch of one visitor, newest first.
    visitor(id) {
      const launches = db.prepare(`
        SELECT ts, country, region, city, browser, os, device, asn, bot
        FROM launches WHERE visitor = ? ORDER BY id DESC LIMIT 500`).all(id);
      if (!launches.length) return null;
      return { visitor: id, launches: launches.map((l) => withNetwork({ ...l, bot: !!l.bot })) };
    },
  };
}

function withNetwork(r) {
  return { ...r, network: r.asn ? DATACENTER_ASNS.get(r.asn) ?? null : null, datacenter: DATACENTER_ASNS.has(r.asn) };
}

export function parseUserAgent(ua = '') {
  const s = String(ua);
  const browser =
    /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
      : /OPR\/|Opera/.test(s) ? 'Opera'
        : /SamsungBrowser\//.test(s) ? 'Samsung Internet'
          : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
            : /Chrome\/|CriOS\/|Chromium\//.test(s) ? 'Chrome'
              : /Safari\//.test(s) && /Version\//.test(s) ? 'Safari'
                : 'Other';
  const os =
    /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Android/.test(s) ? 'Android'
        : /CrOS/.test(s) ? 'ChromeOS'
          : /Windows/.test(s) ? 'Windows'
            : /Mac OS X|Macintosh/.test(s) ? 'macOS'
              : /Linux/.test(s) ? 'Linux'
                : 'Other';
  const device =
    /iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s)) ? 'Tablet'
      : /Mobi|iPhone|iPod/.test(s) ? 'Mobile'
        : 'Desktop';
  return { browser, os, device };
}
