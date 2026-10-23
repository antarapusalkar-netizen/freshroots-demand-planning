import { readFile } from 'node:fs/promises';
import { requirePassword } from '../lib/auth.js';
import { safe, sendText } from '../lib/http.js';

// The dashboard pages, behind the shared password if one is set.
// vercel.json rewrites "/" to the dashboard and "/deepa" to Deepa's read-only page.
const VIEWS = { dashboard: 'dashboard.html', deepa: 'deepa.html' };

export default safe(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Use GET.');
  if (!requirePassword(req, res)) return;
  const view = new URL(req.url, 'http://localhost').searchParams.get('view') || 'dashboard';
  if (!Object.hasOwn(VIEWS, view)) return sendText(res, 404, 'Not found');
  const html = await readFile(new URL(`../views/${VIEWS[view]}`, import.meta.url), 'utf8');
  sendText(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
});
