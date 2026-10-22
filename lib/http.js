// Small helpers that work with plain Node req/res (local dev server) and Vercel functions.

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Wraps a handler so errors become a plain 500 and never leak details to the page.
export function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`${req.method} ${req.url} failed: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Check the server log.' });
    }
  };
}
