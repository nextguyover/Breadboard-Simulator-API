import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { AuthGuard } from '../src/ratelimit.js';

const ADMIN = 'test-admin-token-0123456789abcdef';

test('wrong admin tokens lock the IP out, other IPs are unaffected', async () => {
  const { server } = createApp({
    adminToken: ADMIN, ipHashSalt: 'salt-salt-salt-salt', trustCloudflare: true,
    allowedOrigins: [], appUrl: 'https://app.example.test/',
    perIpWindowMs: 600_000, perIpWindowMax: 5, perIpDailyMax: 20, globalPerSec: 0, globalBurst: 10, globalDailyMax: 0,
    maxBodyBytes: 1024 * 1024, maxScreenshotBytes: 1024 * 1024,
    authFailMax: 3, authFailWindowMs: 60_000, authLockoutMs: 600_000,
  }, openDb(':memory:'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (ip, token) => fetch(`${base}/v1/reports`, { headers: { 'CF-Connecting-IP': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  try {
    assert.equal((await get('192.0.2.1')).status, 401); // no token: not counted
    assert.equal((await get('192.0.2.1', 'guess-1')).status, 401);
    assert.equal((await get('192.0.2.1', 'guess-2')).status, 401);
    const locked = await get('192.0.2.1', 'guess-3');
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '600');
    assert.equal((await locked.json()).error, 'too_many_auth_failures');
    assert.equal((await get('192.0.2.1', ADMIN)).status, 429); // even the right token, while locked
    assert.equal((await fetch(`${base}/v1/analytics`, { headers: { 'CF-Connecting-IP': '192.0.2.1', Authorization: `Bearer ${ADMIN}` } })).status, 429);
    assert.equal((await get('192.0.2.2', ADMIN)).status, 200);
  } finally {
    server.close();
  }
});

test('auth guard: window, lockout expiry, success resets', () => {
  let now = 0;
  const g = new AuthGuard({ authFailMax: 2, authFailWindowMs: 1000, authLockoutMs: 5000 }, () => now);
  assert.equal(g.fail('a'), 0);
  now = 1500; // first failure has left the window
  assert.equal(g.fail('a'), 0);
  assert.equal(g.fail('a'), 5);
  assert.equal(g.lockedFor('a'), 5);
  now += 5000;
  assert.equal(g.lockedFor('a'), 0);
  assert.equal(g.fail('b'), 0);
  g.succeed('b');
  assert.equal(g.fail('b'), 0);
});
