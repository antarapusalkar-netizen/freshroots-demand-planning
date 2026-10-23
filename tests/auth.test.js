import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordOk, requirePassword } from '../lib/auth.js';
import flags from '../api/flags.js';
import decide from '../api/decide.js';
import approved from '../api/approved.js';
import page from '../api/page.js';
import run from '../api/run.js';

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
function fakeRes() {
  return { statusCode: 200, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } };
}

test('passwordOk: right password with any username; wrong, missing and malformed are refused', () => {
  assert.equal(passwordOk(basic('raghav', 's3cret'), 's3cret'), true);
  assert.equal(passwordOk(basic('', 's3cret'), 's3cret'), true);
  assert.equal(passwordOk(basic('x', 'a:b:c'), 'a:b:c'), true); // colons in the password are fine
  assert.equal(passwordOk(basic('x', 'nope'), 's3cret'), false);
  assert.equal(passwordOk(basic('x', 's3cre'), 's3cret'), false);
  assert.equal(passwordOk(undefined, 's3cret'), false);
  assert.equal(passwordOk('Bearer s3cret', 's3cret'), false);
  assert.equal(passwordOk('Basic !!!notbase64', 's3cret'), false);
  assert.equal(passwordOk('Basic ' + Buffer.from('nocolon').toString('base64'), 'nocolon'), false);
});

test('requirePassword: 401 with a Basic challenge when the password is wrong or missing', () => {
  const res = fakeRes();
  assert.equal(requirePassword({ headers: {} }, res, { SITE_PASSWORD: 'pw' }), false);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /^Basic realm=/);
  const ok = fakeRes();
  assert.equal(requirePassword({ headers: { authorization: basic('u', 'pw') } }, ok, { SITE_PASSWORD: 'pw' }), true);
  assert.equal(ok.statusCode, 200);
});

test('requirePassword: with no SITE_PASSWORD the site is open, locally and on Vercel', () => {
  assert.equal(requirePassword({ headers: {} }, fakeRes(), {}), true);
  assert.equal(requirePassword({ headers: {} }, fakeRes(), { VERCEL: '1' }), true);
});

// The handlers must refuse before touching the database. Run with a password set and no DATABASE_URL.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

for (const [name, handler, method] of [['flags', flags, 'GET'], ['approved', approved, 'GET'], ['decide', decide, 'POST'], ['page', page, 'GET'], ['run (manual)', run, 'POST']]) {
  test(`${name}: 401 without the password, even with no database configured`, async () => {
    await withEnv({ SITE_PASSWORD: 'pw', DATABASE_URL: undefined, CRON_SECRET: 'cs' }, async () => {
      const res = fakeRes();
      await handler({ method, url: '/x', headers: {} }, res);
      assert.equal(res.statusCode, 401);
      const bad = fakeRes();
      await handler({ method, url: '/x', headers: { authorization: basic('u', 'wrong') } }, bad);
      assert.equal(bad.statusCode, 401);
    });
  });
}

test('run: scheduled (GET) needs the cron secret, not the site password', async () => {
  await withEnv({ SITE_PASSWORD: 'pw', CRON_SECRET: 'cs', DATABASE_URL: undefined }, async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: basic('u', 'pw') }]) {
      const res = fakeRes();
      await run({ method: 'GET', url: '/api/run', headers }, res);
      assert.equal(res.statusCode, 401);
    }
  });
  await withEnv({ CRON_SECRET: undefined, DATABASE_URL: undefined }, async () => {
    const res = fakeRes();
    await run({ method: 'GET', url: '/api/run', headers: { authorization: 'Bearer undefined' } }, res);
    assert.equal(res.statusCode, 401); // no secret configured: always refused
  });
});

test('run: other methods are refused', async () => {
  const res = fakeRes();
  await run({ method: 'DELETE', url: '/api/run', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
