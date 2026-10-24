import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateEnvText, exchangeCode } from '../scripts/zoho-token.js';

const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csecret', ZOHO_CODE: 'onetimecode', ZOHO_DC: 'in' };
const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('exchange: posts the code to the accounts host, secrets in the body only, returns the refresh token', async () => {
  let seen;
  const token = await exchangeCode(ENV, async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'rt-123' }) }; });
  assert.equal(token, 'rt-123');
  assert.equal(seen.url, 'https://accounts.zoho.in/oauth/v2/token');
  assert.equal(seen.opts.method, 'POST');
  const body = String(seen.opts.body);
  assert.match(body, /grant_type=authorization_code/);
  assert.match(body, /code=onetimecode/);
  assert.ok(!seen.url.includes('csecret') && !seen.url.includes('onetimecode'));
});

test('exchange: a used or expired code gives a clear message without any secret in it', async () => {
  await assert.rejects(() => exchangeCode(ENV, reply({ error: 'invalid_code' }, 400)), (e) => /invalid_code/.test(e.message) && /expires after about 10 minutes/.test(e.message) && !/csecret|onetimecode|cid/.test(e.message));
});

test('exchange: missing settings and a bad data center are refused before any call', async () => {
  let calls = 0;
  const f = async () => { calls += 1; return reply({})(); };
  await assert.rejects(() => exchangeCode({ ...ENV, ZOHO_CODE: '' }, f), /ZOHO_CODE is not set/);
  await assert.rejects(() => exchangeCode({ ...ENV, ZOHO_CLIENT_SECRET: undefined }, f), /ZOHO_CLIENT_SECRET is not set/);
  await assert.rejects(() => exchangeCode({ ...ENV, ZOHO_DC: 'evil.com/x#' }, f), /ZOHO_DC must be one of/);
  assert.equal(calls, 0);
});

test('env update: refresh token added, code removed, nothing else touched', () => {
  const before = 'DATABASE_URL=postgresql://u:p@h/db?a=1&b=2\nZOHO_CLIENT_ID=cid\nZOHO_CODE=onetimecode\nZOHO_ORG_ID=99\n\n';
  const after = updateEnvText(before, 'rt-123');
  assert.equal(after, 'DATABASE_URL=postgresql://u:p@h/db?a=1&b=2\nZOHO_CLIENT_ID=cid\nZOHO_ORG_ID=99\nZOHO_REFRESH_TOKEN=rt-123\n');
  // running it again replaces the token instead of adding a second one
  assert.equal(updateEnvText(after, 'rt-456').match(/ZOHO_REFRESH_TOKEN=/g).length, 1);
});
