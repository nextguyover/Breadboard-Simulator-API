// App launch analytics. The app pings /healthz once on load; each ping from an allowed app origin
// is logged here as one launch. Location comes from Cloudflare's visitor headers, so no GeoIP
// database is needed and raw IPs are never stored.

const DEDUPE_MS = 10_000; // a second ping from the same visitor within this window is not a new launch

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
      device  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS launches_ts ON launches (ts);
    CREATE INDEX IF NOT EXISTS launches_visitor ON launches (visitor, ts);
  `);

  const recent = db.prepare('SELECT 1 FROM launches WHERE visitor = ? AND ts > ? LIMIT 1');
  const insert = db.prepare(`
    INSERT INTO launches (ts, visitor, country, region, city, browser, os, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    record({ visitor, country, region, city, userAgent }, now = new Date()) {
      if (recent.get(visitor, new Date(now.getTime() - DEDUPE_MS).toISOString())) return false;
      const ua = parseUserAgent(userAgent);
      insert.run(now.toISOString(), visitor, country, region ?? null, city ?? null, ua.browser, ua.os, ua.device);
      return true;
    },

    // days: how far back (0 = everything). tzMinutes: viewer's UTC offset, so days match their calendar.
    summary({ days, tzMinutes }) {
      const shift = `${tzMinutes >= 0 ? '+' : '-'}${Math.abs(tzMinutes)} minutes`;
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
      const where = 'WHERE ts >= ?';
      const one = (sql) => db.prepare(sql).get(since);
      const all = (sql) => db.prepare(sql).all(since);
      const group = (col, limit) => all(`
        SELECT ${col} AS key, COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors
        FROM launches ${where} GROUP BY ${col} ORDER BY launches DESC, key LIMIT ${limit}`);

      const totals = one(`SELECT COUNT(*) AS launches, COUNT(DISTINCT visitor) AS visitors FROM launches ${where}`);
      const returning = one(`
        SELECT COUNT(*) AS n FROM (
          SELECT visitor FROM launches ${where} GROUP BY visitor HAVING COUNT(DISTINCT date(ts, '${shift}')) > 1)`).n;
      return {
        totals: { ...totals, returningVisitors: returning },
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
        firstLaunch: one(`SELECT MIN(ts) AS ts FROM launches ${where}`).ts,
      };
    },
  };
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
