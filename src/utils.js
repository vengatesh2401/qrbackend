const crypto = require('crypto');
const QRCode = require('qrcode');
const { UAParser } = require('ua-parser-js');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateShortCode(length = 7) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Renders `data` as a QR code PNG, returned as a base64 string (no
 * data: prefix) so the Flutter app can do Image.memory(base64Decode(...)). */
async function renderQrPngBase64(data) {
  const buffer = await QRCode.toBuffer(data, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 440, // roughly matches box_size=10 on a ~44-module QR from the Python version
  });
  return buffer.toString('base64');
}

function buildVCard({ name, phone = '', email = '', org = '' }) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${name}`, `FN:${name}`];
  if (org) lines.push(`ORG:${org}`);
  if (phone) lines.push(`TEL;TYPE=CELL:${phone}`);
  if (email) lines.push(`EMAIL:${email}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

function buildWifiPayload({ ssid, password = '', security = 'WPA' }) {
  const sec = security ? security.toUpperCase() : 'nopass';
  return `WIFI:T:${sec};S:${ssid};P:${password};;`;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

/** Render's free tier doesn't add geolocation headers the way Vercel does
 * for its own deployments, so this returns nulls there. If you need real
 * geo data on Render, plug in a free IP-geolocation API call here. */
function getGeoInfo(req) {
  const country = req.headers['x-vercel-ip-country'] || null;
  const city = req.headers['x-vercel-ip-city'] || null;
  return { country, city };
}

function parseUserAgent(uaString) {
  if (!uaString) return { deviceType: 'unknown', osName: 'unknown', browser: 'unknown' };

  const { device, os, browser } = UAParser(uaString);

  let deviceType = 'other';
  if (device.type === 'mobile') deviceType = 'mobile';
  else if (device.type === 'tablet') deviceType = 'tablet';
  else if (!device.type) deviceType = 'desktop'; // ua-parser-js leaves type unset for desktop

  return {
    deviceType,
    osName: os.name || 'unknown',
    browser: browser.name || 'unknown',
  };
}

/** Decide the final destination for a scan, honouring device-based
 * redirect overrides if the QR code has any configured. */
function pickRedirectTarget(qr, deviceType, osName) {
  const osLower = (osName || '').toLowerCase();

  if (osLower.includes('android') && qr.android_url) return qr.android_url;
  if ((osLower.includes('ios') || osLower.includes('iphone') || osLower.includes('mac')) && qr.ios_url && deviceType !== 'desktop') {
    return qr.ios_url;
  }
  if (deviceType === 'desktop' && qr.desktop_url) return qr.desktop_url;

  return qr.destination_url;
}

module.exports = {
  generateShortCode,
  renderQrPngBase64,
  buildVCard,
  buildWifiPayload,
  getClientIp,
  getGeoInfo,
  parseUserAgent,
  pickRedirectTarget,
};
