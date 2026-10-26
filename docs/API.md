# Breadboard Simulator API: bug reports (v1)

Small self-hosted service that the Breadboard Simulator web app posts bug
reports to. Reports are stored in SQLite and can be listed and read with an
admin token.

Base URL: wherever it is deployed (for example `https://api.breadboardsimulator.com`).
The app reads it from build config (`VITE_BUG_REPORT_URL`) and hides the
"Report a bug" option when it is not set.

All requests and responses are JSON (`Content-Type: application/json; charset=utf-8`)
unless noted.

---

## Public endpoint

### `POST /v1/reports`

Submit one bug report. CORS-enabled for the app origin(s). No auth.

Request body (max **3 MB** raw, which leaves room for a base64 screenshot):

| Field         | Type   | Required | Limits / notes |
|---------------|--------|----------|----------------|
| `description` | string | yes      | 10 to 5000 chars after trimming. What happened, what was expected. |
| `appVersion`  | string | yes      | 1 to 64 chars, e.g. `"2.0.0-beta.3+a1b2c3d"`. |
| `contact`     | string | no       | 0 to 200 chars. Email or any handle, only if the user chooses to give it. |
| `userAgent`   | string | no       | 0 to 512 chars. `navigator.userAgent`. If omitted, the server stores the request's `User-Agent` header. |
| `circuit`     | string | no       | 0 to 200 000 chars, no whitespace. The share-link fragment without the leading `#` (e.g. `c1.<base64url>`), so `APP_URL + '#' + circuit` opens it. |
| `screenshot`  | string | no       | Data URL `data:image/(png|jpeg|webp);base64,...`, decoded size at most **2 MB**. Downscale before sending (e.g. longest side 1600 px, WebP/JPEG ~0.85). |
| `diagnostics` | object | no       | Free-form JSON, at most **16 KB** when serialised. Suggested keys: `viewport` (`{w,h,dpr}`), `platform`, `touch` (bool), `webgl` (renderer string), `engineState`, `recentErrors` (array of the last ~20 console errors / engine messages, strings truncated to ~500 chars), `route`. |
| `website`     | string | no       | **Honeypot.** The app must never set it (or must send `""`). A non-empty value is silently accepted with a fake `201` and discarded. |

Unknown top-level fields are rejected (`400 validation_failed`) so typos are caught early.

Example:

```json
{
  "description": "Running the 555 example then moving the capacitor freezes the sim on 'Starting engine'.",
  "appVersion": "2.0.0-beta.3+a1b2c3d",
  "contact": "someone@example.com",
  "userAgent": "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  "circuit": "c1.N4IgdghgtgpiBcIBOB...",
  "screenshot": "data:image/webp;base64,UklGR...",
  "diagnostics": { "viewport": { "w": 412, "h": 915, "dpr": 2.6 }, "touch": true, "recentErrors": ["ngspice: timestep too small"] }
}
```

Success, `201 Created`:

```json
{ "id": 42, "createdAt": "2026-10-26T09:30:00.000Z" }
```

The app can show "Thanks! Report #42 sent."

### Errors

Every error response has this shape:

```json
{ "error": "validation_failed", "message": "Human readable text", "fields": { "description": "must be at least 10 characters" } }
```

`fields` is present only for `validation_failed`.

| Status | `error`                  | When |
|--------|--------------------------|------|
| 400    | `invalid_json`           | Body is not valid JSON or not an object. |
| 400    | `validation_failed`      | A field is missing, the wrong type, too long, an unknown field was sent, or the screenshot is not a valid PNG/JPEG/WebP data URL. |
| 403    | `origin_not_allowed`     | Browser request whose `Origin` is not in the allow-list. |
| 401    | `unauthorized`           | Admin endpoint without a valid token. |
| 404    | `not_found`              | Unknown path or report id. |
| 413    | `payload_too_large`      | Raw body over 3 MB, or decoded screenshot over 2 MB. |
| 415    | `unsupported_media_type` | `Content-Type` is not `application/json`. |
| 429    | `rate_limited`           | Too many reports. Response has a `Retry-After` header (seconds) and `"retryAfter": <seconds>` in the body. |
| 503    | `daily_limit_reached`    | Optional global daily cap hit (off by default). Also has `Retry-After`. |
| 500    | `internal_error`         | Anything else. |

Suggested app behaviour: on 400 show the field messages; on 429/503 show
"Too many reports right now, try again in N seconds" and keep the form
contents; on network error / 5xx keep the form and offer Retry. Never lose
what the user typed.

### CORS

- Allowed origins come from `ALLOWED_ORIGINS` (comma separated). Default:
  `https://app.breadboardsimulator.com`. Add `http://localhost:5173` for dev.
- `OPTIONS /v1/reports` preflight returns `204` with
  `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: POST`,
  `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 86400`,
  `Vary: Origin`.
- No cookies or credentials are used.

### Rate limits (defaults, all configurable)

Applied to `POST /v1/reports` only, and only accepted reports count:

- **Per IP**: 5 reports per 10 minutes and 20 per UTC day. The client IP is
  `CF-Connecting-IP` when `TRUST_CLOUDFLARE=1`, otherwise the socket address.
- **Global** (off by default): a requests-per-second token bucket and a daily
  cap (`503 daily_limit_reached`) can be switched on if a flood ever comes
  from many IPs at once. A global limit alone would let one script block
  every real user, so per-IP limits are the main guard. Cloudflare's free WAF
  rate-limiting rule is another optional layer.

Important: only trust `CF-Connecting-IP` when the origin is reachable only
through Cloudflare (Cloudflare Tunnel, or a firewall that only allows
Cloudflare IP ranges). Otherwise anyone can spoof it.

Raw IPs are never stored. The server keeps a salted SHA-256 hash of the IP
(salt from `IP_HASH_SALT`) so repeated spam from one source can be spotted
and deleted.

---

## Admin endpoints

All need `Authorization: Bearer <ADMIN_TOKEN>`. Wrong or missing token gives
`401 unauthorized`. No CORS (same-origin admin page only).

### `GET /v1/reports?limit=50&before=<id>&status=<status>`

Newest first. `limit` 1 to 200 (default 50). `before` is for paging
(pass the last `id` you got). `status` optional filter.

```json
{
  "reports": [
    {
      "id": 42,
      "createdAt": "2026-10-26T09:30:00.000Z",
      "status": "new",
      "appVersion": "2.0.0-beta.3+a1b2c3d",
      "summary": "Running the 555 example then moving the capacitor freezes…",
      "hasContact": true,
      "hasCircuit": true,
      "hasScreenshot": true
    }
  ],
  "nextBefore": 41,
  "counts": { "new": 12, "fixed": 30 }
}
```

`nextBefore` is `null` when there are no more. `counts` is the number of
reports per status (statuses with none are left out).

### `GET /v1/reports/:id`

Full report: every submitted field (minus the screenshot bytes), plus
`id`, `createdAt`, `status`, `note`, `ipHash`, `screenshotUrl`
(`/v1/reports/42/screenshot` or `null`).

### `GET /v1/reports/:id/screenshot`

The raw image with its own `Content-Type`. `404 not_found` if none.

### `PATCH /v1/reports/:id`

```json
{ "status": "fixed", "note": "Fixed in 2.0.0-beta.4" }
```

`status` is one of `new`, `triaged`, `fixed`, `wontfix`, `duplicate`, `spam`.
`note` is up to 2000 chars. Returns the updated report.

### `DELETE /v1/reports/:id`

`204 No Content`.

### `GET /admin`

A small built-in web page (no build step) that asks for the admin token once,
keeps it in `localStorage`, and lists, filters, opens and updates reports. It
links to the app with `#<circuit>` so a reported circuit opens in one click.

---

## Other

- `GET /healthz` returns `200 {"ok":true}`.
- Every response has `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
