import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordForAi, numbersOk, explainOne, explainRun } from '../lib/explain.js';
import { SYSTEM_PROMPT } from '../lib/explain-prompt.js';

const row = { id: 7, sku_name: 'Freshroots Mango Drink 200ml', flag_types: ['high-demand', 'stockout-risk'], is_exception: false,
  recommended_action: 'reorder-now', recommended_qty: 750,
  rule_reason: 'Stock of 900 covers 3.4 weeks of sales, below the 6-week minimum. Sales over the last 4 weeks average 326.3 a week, 21% above the 12-week average of 268.6.',
  sku_id: 'SKU001', distributor_id: 'DIST001', secret_extra: 'must not leave' };
const CFG = { apiKey: 'sk-test-KEY123', model: 'test-model' };
const reply = (content, status = 200) => ({ ok: status < 400, status, json: async () => ({ choices: [{ message: { content } }] }) });

test('only the allowed fields go to OpenAI', () => {
  const rec = recordForAi(row);
  assert.deepEqual(Object.keys(rec).sort(), ['flags', 'recommended_action', 'recommended_quantity', 'rule_reason', 'sent_to_exceptions', 'sku_name']);
  assert.ok(!JSON.stringify(rec).includes('DIST001'));
  assert.ok(!JSON.stringify(rec).includes('must not leave'));
});

test('numbersOk: only numbers already in the record are allowed', () => {
  const rec = recordForAi(row);
  assert.equal(numbersOk('Stock covers 3.4 weeks against a 6-week minimum; recent sales are 21% above average.', rec), true);
  assert.equal(numbersOk('It should be reordered soon.', rec), true);
  assert.equal(numbersOk('Stock covers 5 weeks.', rec), false);          // invented
  assert.equal(numbersOk('Stock covers 3.5 weeks.', rec), false);         // altered
  assert.equal(numbersOk('Reorder 1.5x the usual amount.', rec), false);  // 1.5 is not in the record
});

test('explainOne: correct request, text returned and trimmed', async () => {
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return reply('  Stock covers 3.4 weeks against a 6-week minimum.\n'); };
  const out = await explainOne(recordForAi(row), CFG, fetchFn);
  assert.equal(out.text, 'Stock covers 3.4 weeks against a 6-week minimum.');
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk-test-KEY123');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.deepEqual(JSON.parse(body.messages[1].content), recordForAi(row));
  assert.ok(!seen.opts.body.includes('sk-test-KEY123'), 'key must be in the header only');
  assert.ok(!seen.url.includes('KEY123'));
});

test('explainOne: failures give an error code and no text, never the key', async () => {
  const rec = recordForAi(row);
  for (const [fetchFn, code] of [
    [async () => reply('x', 401), 'http_401'],
    [async () => reply('x', 429), 'http_429'],
    [async () => reply('x', 500), 'http_500'],
    [async () => { throw new Error('network sk-test-KEY123'); }, 'no_response'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }), 'empty'],
    [async () => reply('   '), 'empty'],
    [async () => reply('x'.repeat(501)), 'too_long'],
    [async () => reply('Stock covers 5 weeks.'), 'invented_number'],
  ]) {
    const out = await explainOne(rec, CFG, fetchFn);
    assert.equal(out.text, undefined, code);
    assert.equal(out.error, code);
    assert.ok(!JSON.stringify(out).includes('KEY123'));
  }
});

function fakePool(rows) {
  const log = [];
  return { log, query: async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: /^\s*SELECT/i.test(sql) ? rows : [] }; } };
}

test('explainRun without a key or model does nothing: no query, no call', async () => {
  for (const env of [{}, { OPENAI_API_KEY: 'k' }, { OPENAI_MODEL: 'm' }]) {
    const pool = fakePool([row]);
    let calls = 0;
    const out = await explainRun(pool, 1, env, async () => { calls += 1; return reply('x'); });
    assert.deepEqual(out, { state: 'off' });
    assert.equal(calls, 0);
    assert.equal(pool.log.length, 0);
  }
});

test('explainRun saves ai_reason per line and changes nothing else', async () => {
  const rows = [{ ...row, id: 1 }, { ...row, id: 2 }, { ...row, id: 3 }];
  const pool = fakePool(rows);
  const out = await explainRun(pool, 9, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, async () => reply('Stock covers 3.4 weeks.'));
  assert.equal(out.state, 'ok');
  assert.equal(out.explained, 3);
  const updates = pool.log.filter((l) => !l.sql.startsWith('SELECT'));
  assert.equal(updates.length, 3);
  for (const u of updates) assert.equal(u.sql, 'UPDATE flags SET ai_reason = $1 WHERE id = $2');
  assert.deepEqual(updates.map((u) => u.params[1]).sort(), [1, 2, 3]);
  assert.match(pool.log[0].sql, /f\.is_exception OR cardinality\(f\.flag_types\) > 0/); // no-action SKUs are not sent
});

test('explainRun: one failure does not stop the others; all failing is reported', async () => {
  const rows = [{ ...row, id: 1 }, { ...row, id: 2 }, { ...row, id: 3 }, { ...row, id: 4 }, { ...row, id: 5 }];
  let n = 0;
  const pool = fakePool(rows);
  const out = await explainRun(pool, 1, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, async () => (++n === 2 ? reply('x', 500) : reply('Stock covers 3.4 weeks.')));
  assert.equal(out.state, 'ok');
  assert.equal(out.explained, 4);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.errors, { http_500: 1 });
  const allBad = await explainRun(fakePool(rows), 1, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, async () => reply('x', 401));
  assert.equal(allBad.state, 'failed');
  assert.equal(allBad.explained, 0);
});

test('explainRun never throws, even if the database does', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const out = await explainRun(pool, 1, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, async () => reply('x'));
  assert.equal(out.state, 'failed');
});
