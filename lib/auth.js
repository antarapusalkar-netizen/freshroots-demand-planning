import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

// HTTP Basic auth with one shared password. The username is ignored.
export function passwordOk(header, expected) {
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return timingSafeEqual(sha(decoded.slice(i + 1)), sha(expected));
}

// Returns true if the request may continue. Otherwise the reply has already been sent.
// The password is optional: with no SITE_PASSWORD set the site is open. Set it (in .env and
// in Vercel) to switch the gate back on.
export function requirePassword(req, res, env = process.env) {
  const expected = env.SITE_PASSWORD;
  if (!expected) return true;
  if (passwordOk(req.headers.authorization, expected)) return true;
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="Freshroots", charset="UTF-8"');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('Password required.');
  return false;
}

// The SAP upload can overwrite the data the whole app runs on, so it has its own password.
// It fails closed: with no UPLOAD_PASSWORD set the upload is refused, everywhere.
// The password comes in the X-Upload-Password header (typed into the page, not a browser pop-up).
export function requireUploadPassword(req, res, env = process.env) {
  const expected = env.UPLOAD_PASSWORD;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!expected) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'UPLOAD_PASSWORD is not set on the server, so uploads are switched off.' }));
    return false;
  }
  const given = req.headers['x-upload-password'];
  if (typeof given === 'string' && timingSafeEqual(sha(given), sha(expected))) return true;
  res.statusCode = 401;
  res.end(JSON.stringify({ error: 'Wrong upload password.' }));
  return false;
}
