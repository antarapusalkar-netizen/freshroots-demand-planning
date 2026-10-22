import { readFile } from 'node:fs/promises';
import { requirePassword } from '../lib/auth.js';
import { safe, sendText } from '../lib/http.js';

// The dashboard page, behind the shared password. vercel.json rewrites "/" to here.
export default safe(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Use GET.');
  if (!requirePassword(req, res)) return;
  const html = await readFile(new URL('../views/dashboard.html', import.meta.url), 'utf8');
  sendText(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
});
