// Validation for POST /v1/reports bodies. Returns { ok, value } or { ok: false, fields, tooLarge }.

const ALLOWED_FIELDS = new Set([
  'description', 'appVersion', 'contact', 'userAgent', 'circuit', 'screenshot', 'diagnostics', 'website',
]);

const SCREENSHOT_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// First bytes of each accepted format, so a data URL can't smuggle something else.
const MAGIC = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

export const STATUSES = ['new', 'triaged', 'fixed', 'wontfix', 'duplicate', 'spam'];

function str(fields, body, key, { required = false, min = 0, max }) {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) fields[key] = 'is required';
    return undefined;
  }
  if (typeof v !== 'string') {
    fields[key] = 'must be a string';
    return undefined;
  }
  const t = v.trim();
  if (required && t.length === 0) fields[key] = 'is required';
  else if (t.length < min) fields[key] = `must be at least ${min} characters`;
  else if (t.length > max) fields[key] = `must be at most ${max} characters`;
  return t.length ? t : undefined;
}

export function validateReport(body, { maxScreenshotBytes }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, invalidJson: true };
  }
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) fields[key] = 'unknown field';
  }

  const value = {
    description: str(fields, body, 'description', { required: true, min: 10, max: 5000 }),
    appVersion: str(fields, body, 'appVersion', { required: true, min: 1, max: 64 }),
    contact: str(fields, body, 'contact', { max: 200 }),
    userAgent: str(fields, body, 'userAgent', { max: 512 }),
    circuit: str(fields, body, 'circuit', { max: 200_000 }),
    honeypot: typeof body.website === 'string' && body.website.trim() !== '',
  };

  if (value.circuit !== undefined && /\s/.test(value.circuit)) {
    fields.circuit = 'must not contain whitespace';
  }

  if (body.diagnostics !== undefined && body.diagnostics !== null) {
    const d = body.diagnostics;
    if (typeof d !== 'object' || Array.isArray(d)) {
      fields.diagnostics = 'must be an object';
    } else {
      const json = JSON.stringify(d);
      if (Buffer.byteLength(json) > 16 * 1024) fields.diagnostics = 'must be at most 16 KB when serialised';
      else value.diagnostics = json;
    }
  }

  let tooLarge = false;
  if (body.screenshot !== undefined && body.screenshot !== null && body.screenshot !== '') {
    const m = typeof body.screenshot === 'string' ? SCREENSHOT_RE.exec(body.screenshot) : null;
    if (!m) {
      fields.screenshot = 'must be a base64 data URL of a PNG, JPEG or WebP image';
    } else {
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > maxScreenshotBytes) {
        tooLarge = true;
        fields.screenshot = `must be at most ${Math.floor(maxScreenshotBytes / 1024 / 1024 * 10) / 10} MB`;
      } else if (!MAGIC[m[1]](bytes)) {
        fields.screenshot = `is not a valid ${m[1]} image`;
      } else {
        value.screenshot = { mime: m[1], bytes };
      }
    }
  }

  if (Object.keys(fields).length) return { ok: false, fields, tooLarge };
  return { ok: true, value };
}

export function validatePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, invalidJson: true };
  const fields = {};
  const value = {};
  for (const key of Object.keys(body)) {
    if (key !== 'status' && key !== 'note') fields[key] = 'unknown field';
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) fields.status = `must be one of ${STATUSES.join(', ')}`;
    else value.status = body.status;
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') fields.note = 'must be a string';
    else if (body.note.length > 2000) fields.note = 'must be at most 2000 characters';
    else value.note = body.note;
  }
  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value };
}
