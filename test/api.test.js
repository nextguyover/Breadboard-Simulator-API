import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { RateLimiter } from '../src/ratelimit.js';

const ADMIN = 'test-admin-token-0123456789abcdef';
const ORIGIN = 'https://app.example.test';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

let base;
let server;

function cfg(overrides = {}) {
  return {
    adminToken: ADMIN, ipHashSalt: 'salt-salt-salt-salt', trustCloudflare: true,
    allowedOrigins: [ORIGIN], appUrl: 'https://app.example.test/',
    perIpWindowMs: 600_000, perIpWindowMax: 5, perIpDailyMax: 20,
    globalPerSec: 0, globalBurst: 10, globalDailyMax: 0,
    maxBodyBytes: 3 * 1024 * 1024, maxScreenshotBytes: 2 * 1024 * 1024,
    ...overrides,
  };
}

before(async () => {
  ({ server } = createApp(cfg(), openDb(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;

function post(body, { ip = freshIp(), origin = ORIGIN, type = 'application/json' } = {}) {
  return fetch(`${base}/v1/reports`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const admin = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json', ...opts.headers } });

const valid = { description: 'The simulator froze after moving a capacitor.', appVersion: '2.0.0-test' };

test('accepts a full report and returns it to the admin', async () => {
  const res = await post({ ...valid, contact: 'me@example.com', circuit: 'c1.abc-_DEF', screenshot: PNG,
    userAgent: 'TestUA/1.0', diagnostics: { viewport: { w: 400, h: 800 } } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const { id, createdAt } = await res.json();
  assert.ok(id > 0 && createdAt);

  const full = await (await admin(`/v1/reports/${id}`)).json();
  assert.equal(full.description, valid.description);
  assert.equal(full.contact, 'me@example.com');
  assert.equal(full.circuit, 'c1.abc-_DEF');
  assert.equal(full.userAgent, 'TestUA/1.0');
  assert.deepEqual(full.diagnostics, { viewport: { w: 400, h: 800 } });
  assert.equal(full.status, 'new');
  assert.match(full.ipHash, /^[0-9a-f]{16}$/);
  assert.equal(full.screenshotUrl, `/v1/reports/${id}/screenshot`);

  const shot = await admin(full.screenshotUrl);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.equal((await shot.arrayBuffer()).byteLength, 12);
});

test('falls back to the User-Agent header', async () => {
  const { id } = await (await post(valid)).json();
  const full = await (await admin(`/v1/reports/${id}`)).json();
  assert.ok(full.userAgent.length > 0);
});

test('lists newest first with paging, status filter and counts', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await post({ ...valid, description: `Report number ${i} for paging` })).json()).id);
  const page = await (await admin('/v1/reports?limit=2')).json();
  assert.deepEqual(page.reports.map((r) => r.id), [ids[2], ids[1]]);
  assert.equal(page.nextBefore, ids[1]);
  assert.equal(page.reports[0].summary, 'Report number 2 for paging');
  assert.ok(page.counts.new >= 3);

  await admin(`/v1/reports/${ids[0]}`, { method: 'PATCH', body: JSON.stringify({ status: 'fixed', note: 'done' }) });
  const fixed = await (await admin('/v1/reports?status=fixed')).json();
  assert.deepEqual(fixed.reports.map((r) => r.id), [ids[0]]);
});

test('patch and delete', async () => {
  const { id } = await (await post(valid)).json();
  const patched = await (await admin(`/v1/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'triaged', note: 'look later' }) })).json();
  assert.equal(patched.status, 'triaged');
  assert.equal(patched.note, 'look later');
  assert.equal((await admin(`/v1/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'nope' }) })).status, 400);
  assert.equal((await admin(`/v1/reports/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin(`/v1/reports/${id}`)).status, 404);
  assert.equal((await admin(`/v1/reports/${id}`, { method: 'DELETE' })).status, 404);
});

test('validation errors name the fields', async () => {
  const res = await post({ description: 'short', extra: 1 });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const body = await res.json();
  assert.equal(body.error, 'validation_failed');
  assert.equal(body.fields.description, 'must be at least 10 characters');
  assert.equal(body.fields.appVersion, 'is required');
  assert.equal(body.fields.extra, 'unknown field');

  const bad = await (await post({ ...valid, screenshot: 'data:image/png;base64,AAAA', diagnostics: [1] })).json();
  assert.equal(bad.fields.screenshot, 'is not a valid image/png image');
  assert.equal(bad.fields.diagnostics, 'must be an object');
  assert.equal((await (await post({ ...valid, screenshot: 'data:image/svg+xml;base64,AAAA' })).json()).error, 'validation_failed');
});

test('bad JSON, wrong type, too large', async () => {
  assert.equal((await (await post('{nope')).json()).error, 'invalid_json');
  assert.equal((await (await post('[1,2]')).json()).error, 'invalid_json');
  assert.equal((await post(valid, { type: 'text/plain' })).status, 415);
  const big = await post({ ...valid, circuit: 'x'.repeat(3.5 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'payload_too_large');
  const bigShot = 'data:image/png;base64,' + Buffer.alloc(2.2 * 1024 * 1024, 0x89).toString('base64');
  const r = await post({ ...valid, screenshot: bigShot });
  assert.equal(r.status, 413);
});

test('CORS preflight and origin allow-list', async () => {
  const pre = await fetch(`${base}/v1/reports`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST');
  const evil = await post(valid, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error, 'origin_not_allowed');
  assert.equal((await post(valid, { origin: null })).status, 201);
});

test('honeypot looks like success but stores nothing', async () => {
  const before = (await (await admin('/v1/reports?limit=1')).json()).reports[0].id;
  const res = await post({ ...valid, website: 'http://spam.example' });
  assert.equal(res.status, 201);
  const after = (await (await admin('/v1/reports?limit=1')).json()).reports[0].id;
  assert.equal(after, before);
});

test('per-IP limit blocks one sender without blocking others', async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) assert.equal((await post(valid, { ip })).status, 201);
  const limited = await post(valid, { ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.headers.get('access-control-allow-origin'), ORIGIN);
  const body = await limited.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retryAfter > 0);
  assert.equal((await post(valid)).status, 201);
});

test('admin endpoints need the token', async () => {
  assert.equal((await fetch(`${base}/v1/reports`)).status, 401);
  assert.equal((await fetch(`${base}/v1/reports/1`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('health check is readable from the app origin only', async () => {
  const app = await fetch(`${base}/healthz`, { headers: { Origin: ORIGIN } });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('access-control-allow-origin'), ORIGIN);
  const other = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('rate limiter: windows, daily caps and optional global limits', () => {
  let now = Date.UTC(2026, 9, 26, 12);
  const rl = new RateLimiter(cfg({ perIpWindowMax: 2, perIpWindowMs: 60_000, perIpDailyMax: 3 }), () => now);
  assert.equal(rl.take('a'), null);
  assert.equal(rl.take('a'), null);
  assert.equal(rl.take('a').retryAfter, 60);
  now += 61_000;
  assert.equal(rl.take('a'), null);
  now += 61_000;
  assert.equal(rl.take('a').error, 'rate_limited'); // daily cap of 3
  now = Date.UTC(2026, 9, 27, 0, 0, 1);
  assert.equal(rl.take('a'), null); // new UTC day

  const g = new RateLimiter(cfg({ globalPerSec: 1, globalBurst: 2, globalDailyMax: 3 }), () => now);
  assert.equal(g.take('x'), null);
  assert.equal(g.take('y'), null);
  assert.equal(g.take('z').retryAfter, 1);
  now += 1000;
  assert.equal(g.take('z'), null);
  now += 5000;
  assert.equal(g.take('w').error, 'daily_limit_reached');
});
