import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setupAnalytics } from './analytics.js';

const SUMMARY_LEN = 140;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'new',
      note            TEXT,
      description     TEXT    NOT NULL,
      app_version     TEXT    NOT NULL,
      contact         TEXT,
      user_agent      TEXT,
      circuit         TEXT,
      diagnostics     TEXT,
      screenshot_mime TEXT,
      screenshot      BLOB,
      ip_hash         TEXT
    );
    CREATE INDEX IF NOT EXISTS reports_status ON reports (status, id);
  `);

  const insert = db.prepare(`
    INSERT INTO reports (created_at, description, app_version, contact, user_agent, circuit, diagnostics,
                         screenshot_mime, screenshot, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listCols = `id, created_at, status, app_version, substr(description, 1, ${SUMMARY_LEN + 1}) AS head,
    contact IS NOT NULL AS has_contact, circuit IS NOT NULL AS has_circuit, screenshot IS NOT NULL AS has_screenshot`;
  const listAll = db.prepare(`SELECT ${listCols} FROM reports WHERE id < ? ORDER BY id DESC LIMIT ?`);
  const listByStatus = db.prepare(`SELECT ${listCols} FROM reports WHERE id < ? AND status = ? ORDER BY id DESC LIMIT ?`);
  const getOne = db.prepare(`
    SELECT id, created_at, status, note, description, app_version, contact, user_agent, circuit, diagnostics,
           screenshot IS NOT NULL AS has_screenshot, ip_hash
    FROM reports WHERE id = ?`);
  const getShot = db.prepare('SELECT screenshot_mime, screenshot FROM reports WHERE id = ? AND screenshot IS NOT NULL');
  const del = db.prepare('DELETE FROM reports WHERE id = ?');
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status');

  return {
    analytics: setupAnalytics(db),

    insert(r) {
      const createdAt = new Date().toISOString();
      const res = insert.run(
        createdAt, r.description, r.appVersion, r.contact ?? null, r.userAgent ?? null, r.circuit ?? null,
        r.diagnostics ?? null, r.screenshot?.mime ?? null, r.screenshot?.bytes ?? null, r.ipHash ?? null,
      );
      return { id: Number(res.lastInsertRowid), createdAt };
    },

    list({ limit, before, status }) {
      const b = before ?? Number.MAX_SAFE_INTEGER;
      const rows = status ? listByStatus.all(b, status, limit + 1) : listAll.all(b, limit + 1);
      const more = rows.length > limit;
      const reports = rows.slice(0, limit).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        appVersion: row.app_version,
        summary: summarise(row.head),
        hasContact: !!row.has_contact,
        hasCircuit: !!row.has_circuit,
        hasScreenshot: !!row.has_screenshot,
      }));
      return { reports, nextBefore: more ? reports[reports.length - 1].id : null };
    },

    get(id) {
      const row = getOne.get(id);
      if (!row) return null;
      return {
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        note: row.note,
        description: row.description,
        appVersion: row.app_version,
        contact: row.contact,
        userAgent: row.user_agent,
        circuit: row.circuit,
        diagnostics: row.diagnostics ? JSON.parse(row.diagnostics) : null,
        screenshotUrl: row.has_screenshot ? `/v1/reports/${row.id}/screenshot` : null,
        ipHash: row.ip_hash,
      };
    },

    screenshot(id) {
      const row = getShot.get(id);
      return row ? { mime: row.screenshot_mime, bytes: row.screenshot } : null;
    },

    update(id, { status, note }) {
      const sets = [];
      const args = [];
      if (status !== undefined) { sets.push('status = ?'); args.push(status); }
      if (note !== undefined) { sets.push('note = ?'); args.push(note === '' ? null : note); }
      if (sets.length) db.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      return this.get(id);
    },

    delete(id) {
      return del.run(id).changes > 0;
    },

    counts() {
      return Object.fromEntries(counts.all().map((r) => [r.status, r.n]));
    },

    close() {
      db.close();
    },
  };
}

function summarise(head) {
  const flat = head.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_LEN ? `${flat.slice(0, SUMMARY_LEN - 1).trimEnd()}…` : flat;
}
