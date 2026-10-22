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
// With no SITE_PASSWORD: allowed on a local machine, refused on Vercel (fails closed).
export function requirePassword(req, res, env = process.env) {
  const expected = env.SITE_PASSWORD;
  if (!expected) {
    if (env.VERCEL) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'SITE_PASSWORD is not set on the server.' }));
      return false;
    }
    return true;
  }
  if (passwordOk(req.headers.authorization, expected)) return true;
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="Freshroots", charset="UTF-8"');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('Password required.');
  return false;
}
