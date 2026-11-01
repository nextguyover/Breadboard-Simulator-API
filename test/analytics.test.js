import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { parseUserAgent } from '../src/analytics.js';

const ADMIN = 'test-admin-token-0123456789abcdef';
const ORIGIN = 'https://app.example.test';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

let base;
let server;

before(async () => {
  ({ server } = createApp({
    adminToken: ADMIN, ipHashSalt: 'salt-salt-salt-salt', trustCloudflare: true,
    allowedOrigins: [ORIGIN], appUrl: 'https://app.example.test/',
    perIpWindowMs: 600_000, perIpWindowMax: 5, perIpDailyMax: 20,
    globalPerSec: 0, globalBurst: 10, globalDailyMax: 0,
    maxBodyBytes: 3 * 1024 * 1024, maxScreenshotBytes: 2 * 1024 * 1024,
  }, openDb(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function ping({ ip, country, city, region, ua = UA_ANDROID, origin = ORIGIN, query = '' }) {
  const headers = { 'CF-Connecting-IP': ip, 'User-Agent': ua };
  if (origin) headers.Origin = origin;
  if (country) headers['CF-IPCountry'] = country;
  // Cloudflare sends UTF-8 bytes; fetch only takes latin1 header strings, so pass them that way.
  if (city) headers['CF-IPCity'] = Buffer.from(city, 'utf8').toString('latin1');
  if (region) headers['CF-Region'] = region;
  return fetch(`${base}/healthz${query}`, { headers });
}
const analytics = async (q = '') =>
  (await fetch(`${base}/v1/analytics${q}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();

test('counts app launches by country, city, device and browser', async () => {
  await ping({ ip: '198.51.100.1', country: 'DE', city: 'München', region: 'Bavaria' });
  await ping({ ip: '198.51.100.2', country: 'AU', ua: UA_MAC });
  await ping({ ip: '198.51.100.3', country: 'AU' });
  await ping({ ip: '198.51.100.3', country: 'AU' }); // repeat within seconds: not a new launch
  await ping({ ip: '198.51.100.4', country: 'AU', query: '?recheck=1' }); // app re-check, not a launch
  await ping({ ip: '198.51.100.5', origin: null }); // monitoring / install check
  await ping({ ip: '198.51.100.6', origin: 'https://evil.example' });
  await ping({ ip: '198.51.100.7' }); // no country header (LAN)

  const a = await analytics('?days=7');
  assert.equal(a.totals.launches, 4);
  assert.equal(a.totals.visitors, 4);
  assert.deepEqual(a.countries.map((c) => [c.key, c.launches]), [['AU', 2], ['DE', 1], ['XX', 1]]);
  assert.deepEqual(a.cities.map((c) => [c.city, c.region, c.country]), [['München', 'Bavaria', 'DE']]);
  assert.equal(a.daily.length, 1);
  assert.equal(a.daily[0].launches, 4);
  assert.deepEqual(Object.fromEntries(a.devices.map((d) => [d.key, d.launches])), { Mobile: 3, Desktop: 1 });
  assert.deepEqual(Object.fromEntries(a.browsers.map((d) => [d.key, d.launches])), { Chrome: 3, Safari: 1 });
  assert.equal(a.hours.reduce((n, h) => n + h.launches, 0), 4);
});

test('analytics needs the admin token and validates its query', async () => {
  assert.equal((await fetch(`${base}/v1/analytics`)).status, 401);
  const bad = await fetch(`${base}/v1/analytics?days=-1`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(bad.status, 400);
  const all = await analytics('?days=0&tz=600');
  assert.equal(all.days, 0);
  assert.ok(all.totals.launches >= 4);
});

test('user agent parsing', () => {
  assert.deepEqual(parseUserAgent(UA_ANDROID), { browser: 'Chrome', os: 'Android', device: 'Mobile' });
  assert.deepEqual(parseUserAgent(UA_MAC), { browser: 'Safari', os: 'macOS', device: 'Desktop' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'),
    { browser: 'Chrome', os: 'iOS', device: 'Tablet' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'),
    { browser: 'Firefox', os: 'Windows', device: 'Desktop' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'),
    { browser: 'Edge', os: 'Windows', device: 'Desktop' });
});
