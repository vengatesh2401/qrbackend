const express = require('express');
const { pool } = require('./db');
const utils = require('./utils');
const security = require('./security');

const router = express.Router();

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
const SHORT_CODE_LENGTH = Number(process.env.SHORT_CODE_LENGTH || 7);

// ---------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------
// Every QR code is tagged with the device that created it (a random ID
// generated once per app install, sent as the X-Device-Id header -- see
// the Flutter app's device_id.dart). This isn't full login-based auth,
// but it's enough to stop every install of the app from seeing and
// editing everyone else's QR codes, which is the actual problem this
// fixes. The public /r/:shortCode redirect is intentionally NOT scoped
// by this -- anyone scanning a printed QR code has no device ID tied to
// the person who created it, and shouldn't need one.

function getDeviceId(req) {
  return req.headers['x-device-id'] || null;
}

function requireDeviceId(req, res) {
  const id = getDeviceId(req);
  if (!id) {
    res.status(400).json({ detail: 'Missing X-Device-Id header' });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function countScans(qrId) {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM scan_events WHERE qr_id = ?', [qrId]);
  return rows[0].c;
}

function toQrOut(row, totalScans) {
  const isExpired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
  return {
    id: row.id,
    qr_type: row.qr_type,
    short_code: row.short_code,
    title: row.title,
    content_type: row.content_type,
    destination_url: row.destination_url,
    is_active: Boolean(row.is_active),
    is_expired: isExpired,
    is_password_protected: Boolean(row.password_hash),
    expires_at: row.expires_at,
    android_url: row.android_url,
    ios_url: row.ios_url,
    desktop_url: row.desktop_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    redirect_url: row.qr_type === 'dynamic' && row.short_code ? `${BASE_URL}/r/${row.short_code}` : null,
    total_scans: totalScans,
  };
}

async function getQrById(id) {
  const [rows] = await pool.query('SELECT * FROM qr_codes WHERE id = ?', [id]);
  return rows[0] || null;
}

/** Fetches a QR by ID and verifies it belongs to this device. Sends 404
 * and returns null if it doesn't exist OR belongs to someone else --
 * deliberately indistinguishable, so the API never reveals that a given
 * ID exists but belongs to a different device. */
async function getOwnedQr(req, res, deviceId) {
  const row = await getQrById(req.params.id);
  if (!row || row.owner_id !== deviceId) {
    res.status(404).json({ detail: 'QR code not found' });
    return null;
  }
  return row;
}

async function getQrByShortCode(shortCode) {
  const [rows] = await pool.query('SELECT * FROM qr_codes WHERE short_code = ?', [shortCode]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------

router.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'dynamic-qr-api' });
});

// ---------------------------------------------------------------------
// QR CODE CRUD
// ---------------------------------------------------------------------

router.post('/api/qrcodes', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;

    const {
      qr_type = 'dynamic',
      title,
      content_type = 'website',
      destination_url,
      password,
      expires_at,
      android_url,
      ios_url,
      desktop_url,
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(422).json({ detail: 'title is required' });
    }
    if (!destination_url || !String(destination_url).trim()) {
      return res.status(422).json({ detail: 'destination_url is required' });
    }
    if (!['dynamic', 'static'].includes(qr_type)) {
      return res.status(422).json({ detail: "qr_type must be 'dynamic' or 'static'" });
    }

    let shortCode = null;
    if (qr_type === 'dynamic') {
      for (let i = 0; i < 5; i++) {
        const candidate = utils.generateShortCode(SHORT_CODE_LENGTH);
        if (!(await getQrByShortCode(candidate))) {
          shortCode = candidate;
          break;
        }
      }
      if (!shortCode) {
        return res.status(500).json({ detail: 'Could not generate a unique short code, try again' });
      }
    }

    const passwordHash = password ? await security.hashPassword(password) : null;

    const [result] = await pool.query(
      `INSERT INTO qr_codes
        (qr_type, short_code, title, content_type, destination_url, expires_at,
         password_hash, android_url, ios_url, desktop_url, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        qr_type,
        shortCode,
        title,
        content_type,
        destination_url,
        expires_at || null,
        passwordHash,
        android_url || null,
        ios_url || null,
        desktop_url || null,
        deviceId,
      ]
    );

    const row = await getQrById(result.insertId);

    // What actually gets embedded in the QR image:
    //  - dynamic -> our short redirect URL (so it can change later)
    //  - static  -> the raw destination content (never changes)
    const encodedData = qr_type === 'dynamic' ? `${BASE_URL}/r/${shortCode}` : destination_url;
    const imageBase64 = await utils.renderQrPngBase64(encodedData);

    res.json({
      qr_code: toQrOut(row, 0),
      qr_image_base64: imageBase64,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.get('/api/qrcodes', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;

    const skip = Number(req.query.skip || 0);
    const limit = Number(req.query.limit || 100);

    // Single query with a LEFT JOIN + GROUP BY gets every row's scan count
    // in one round-trip, instead of the list query plus one extra count
    // query per row (which is what was making this screen slow to load).
    const [rows] = await pool.query(
      `SELECT q.*, COUNT(s.id) AS total_scans
       FROM qr_codes q
       LEFT JOIN scan_events s ON s.qr_id = q.id
       WHERE q.owner_id = ?
       GROUP BY q.id
       ORDER BY q.created_at DESC
       LIMIT ? OFFSET ?`,
      [deviceId, limit, skip]
    );

    const out = rows.map((row) => toQrOut(row, Number(row.total_scans)));
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.get('/api/qrcodes/:id', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const row = await getOwnedQr(req, res, deviceId);
    if (!row) return;
    res.json(toQrOut(row, await countScans(row.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.get('/api/qrcodes/:id/image', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const row = await getOwnedQr(req, res, deviceId);
    if (!row) return;

    const encodedData = row.qr_type === 'dynamic' ? `${BASE_URL}/r/${row.short_code}` : row.destination_url;
    const imageBase64 = await utils.renderQrPngBase64(encodedData);
    res.json({ qr_image_base64: imageBase64 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.put('/api/qrcodes/:id', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const row = await getOwnedQr(req, res, deviceId);
    if (!row) return;

    const { title, destination_url, is_active, expires_at, password, android_url, ios_url, desktop_url } = req.body || {};

    if (row.qr_type === 'static' && destination_url !== undefined) {
      return res.status(400).json({
        detail:
          "Static QR codes cannot be edited -- their content is baked into the image itself. Create a new one instead.",
      });
    }

    const fields = [];
    const values = [];

    if (title !== undefined) { fields.push('title = ?'); values.push(title); }
    if (destination_url !== undefined) { fields.push('destination_url = ?'); values.push(destination_url); }
    if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active); }
    if (expires_at !== undefined) { fields.push('expires_at = ?'); values.push(expires_at); }
    if (password !== undefined) {
      fields.push('password_hash = ?');
      values.push(password ? await security.hashPassword(password) : null);
    }
    if (android_url !== undefined) { fields.push('android_url = ?'); values.push(android_url); }
    if (ios_url !== undefined) { fields.push('ios_url = ?'); values.push(ios_url); }
    if (desktop_url !== undefined) { fields.push('desktop_url = ?'); values.push(desktop_url); }

    if (fields.length > 0) {
      values.push(req.params.id);
      await pool.query(`UPDATE qr_codes SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    const updated = await getQrById(req.params.id);
    res.json(toQrOut(updated, await countScans(updated.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.patch('/api/qrcodes/:id/toggle', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const row = await getOwnedQr(req, res, deviceId);
    if (!row) return;

    await pool.query('UPDATE qr_codes SET is_active = ? WHERE id = ?', [!row.is_active, req.params.id]);

    const updated = await getQrById(req.params.id);
    res.json(toQrOut(updated, await countScans(updated.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.delete('/api/qrcodes/:id', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const row = await getOwnedQr(req, res, deviceId);
    if (!row) return;

    await pool.query('DELETE FROM qr_codes WHERE id = ?', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------

router.get('/api/qrcodes/:id/analytics', async (req, res) => {
  try {
    const deviceId = requireDeviceId(req, res);
    if (!deviceId) return;
    const qr = await getOwnedQr(req, res, deviceId);
    if (!qr) return;
    if (qr.qr_type === 'static') {
      return res.status(400).json({
        detail: 'Static QR codes never touch the server when scanned, so no analytics exist for them.',
      });
    }

    const [scans] = await pool.query(
      'SELECT * FROM scan_events WHERE qr_id = ? ORDER BY scanned_at DESC',
      [req.params.id]
    );

    const total = scans.length;
    const uniqueIps = new Set(scans.filter((s) => s.ip_address).map((s) => s.ip_address));

    const tally = (key) => {
      const counts = {};
      for (const s of scans) {
        const v = s[key] || 'unknown';
        counts[v] = (counts[v] || 0) + 1;
      }
      return counts;
    };

    const byDay = {};
    for (const s of scans) {
      const day = new Date(s.scanned_at).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const scansByDay = Object.entries(byDay)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, count]) => ({ date, count }));

    const recentScans = scans.slice(0, 25).map((s) => ({
      id: s.id,
      scanned_at: s.scanned_at,
      device_type: s.device_type,
      os_name: s.os_name,
      browser: s.browser,
      country: s.country,
      city: s.city,
    }));

    res.json({
      qr_id: Number(req.params.id),
      total_scans: total,
      unique_scans: uniqueIps.size,
      by_device: tally('device_type'),
      by_os: tally('os_name'),
      by_browser: tally('browser'),
      by_country: tally('country'),
      scans_by_day: scansByDay,
      recent_scans: recentScans,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------
// PUBLIC REDIRECT ENDPOINT -- this is what's actually embedded in the
// dynamic QR image. Anyone's camera app hits this when they scan.
// ---------------------------------------------------------------------

function passwordFormHtml(shortCode, errorHtml = '') {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Protected link</title>
<style>
body { font-family: -apple-system, Roboto, Arial, sans-serif; background:#f4f5f7; display:flex;
       align-items:center; justify-content:center; height:100vh; margin:0; }
.card { background:#fff; padding:32px; border-radius:12px; box-shadow:0 4px 24px rgba(0,0,0,.08); width:90%; max-width:360px; text-align:center; }
input { width:100%; padding:12px; margin:16px 0; border:1px solid #ddd; border-radius:8px; font-size:16px; box-sizing:border-box; }
button { width:100%; padding:12px; background:#4f46e5; color:#fff; border:none; border-radius:8px; font-size:16px; cursor:pointer; }
.error { color:#e11d48; font-size:14px; margin-top:-8px; margin-bottom:8px; }
</style>
</head>
<body>
  <div class="card">
    <h3>🔒 This link is password protected</h3>
    ${errorHtml}
    <form method="post" action="/r/${shortCode}">
      <input type="password" name="password" placeholder="Enter password" autofocus required>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function inactiveHtml(message) {
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link unavailable</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f5f7;}
.card{background:#fff;padding:32px;border-radius:12px;text-align:center;max-width:360px;}</style></head>
<body><div class="card"><h3>⚠️ ${message}</h3><p>This QR code is currently unavailable. Please contact whoever shared it with you.</p></div></body></html>`;
}

async function resolveAndRedirect(qr, req, res) {
  const { deviceType, osName, browser } = utils.parseUserAgent(req.headers['user-agent']);
  const { country, city } = utils.getGeoInfo(req);
  const ip = utils.getClientIp(req);

  await pool.query(
    `INSERT INTO scan_events (qr_id, ip_address, device_type, os_name, browser, country, city, referrer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [qr.id, ip, deviceType, osName, browser, country, city, req.headers['referer'] || null]
  );

  const target = utils.pickRedirectTarget(qr, deviceType, osName);
  res.redirect(303, target);
}

router.get('/r/:shortCode', async (req, res) => {
  try {
    const qr = await getQrByShortCode(req.params.shortCode);
    if (!qr) return res.status(404).json({ detail: 'This QR code does not exist' });

    if (!qr.is_active) {
      return res.status(410).type('html').send(inactiveHtml('This QR code has been disabled'));
    }
    const isExpired = qr.expires_at ? new Date(qr.expires_at).getTime() < Date.now() : false;
    if (isExpired) {
      return res.status(410).type('html').send(inactiveHtml('This QR code has expired'));
    }
    if (qr.password_hash) {
      return res.type('html').send(passwordFormHtml(req.params.shortCode));
    }

    await resolveAndRedirect(qr, req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.post('/r/:shortCode', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const qr = await getQrByShortCode(req.params.shortCode);
    if (!qr) return res.status(404).json({ detail: 'This QR code does not exist' });

    const isExpired = qr.expires_at ? new Date(qr.expires_at).getTime() < Date.now() : false;
    if (!qr.is_active || isExpired) {
      return res.status(410).type('html').send(inactiveHtml('This QR code is no longer available'));
    }

    const password = (req.body && req.body.password) || '';
    const ok = qr.password_hash && (await security.verifyPassword(password, qr.password_hash));
    if (!ok) {
      const errorHtml = '<p class="error">Incorrect password, try again.</p>';
      return res.status(401).type('html').send(passwordFormHtml(req.params.shortCode, errorHtml));
    }

    await resolveAndRedirect(qr, req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

module.exports = router;
