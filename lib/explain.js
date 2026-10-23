import { SYSTEM_PROMPT } from './explain-prompt.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 20000;
const MAX_CHARS = 500;
const CONCURRENCY = 4;

// Only these fields leave the system. No distributor, stock figures beyond the rule text, or other SKUs.
export function recordForAi(f) {
  return {
    sku_name: f.sku_name,
    flags: f.flag_types,
    sent_to_exceptions: f.is_exception,
    recommended_action: f.recommended_action,
    recommended_quantity: f.recommended_qty,
    rule_reason: f.rule_reason,
  };
}

const numbersIn = (t) => String(t).match(/\d+(?:\.\d+)?/g) || [];

// The explanation may only use numbers that are already in the record.
export function numbersOk(output, record) {
  const allowed = new Set(numbersIn(JSON.stringify(record)));
  return numbersIn(output).every((n) => allowed.has(n));
}

// Returns { text } or { error } (a short code). Never throws, never includes the key.
export async function explainOne(record, { apiKey, model }, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(record) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { error: 'no_response' };
  }
  if (!res.ok) return { error: `http_${res.status}` };
  const json = await res.json().catch(() => null);
  const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty' };
  const clean = text.trim();
  if (clean.length > MAX_CHARS) return { error: 'too_long' };
  if (!numbersOk(clean, record)) return { error: 'invented_number' };
  return { text: clean };
}

// Adds ai_reason to the flagged and exception lines of one run. It touches nothing else.
// Never throws. Without OPENAI_API_KEY and OPENAI_MODEL it does nothing, and the page shows
// the rule's own reason. A failed call leaves that line's ai_reason empty.
export async function explainRun(pool, runId, env = process.env, fetchFn = fetch) {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!apiKey || !model) return { state: 'off' };
  try {
    const { rows } = await pool.query(
      `SELECT f.id, s.sku_name, f.flag_types, f.is_exception, f.recommended_action, f.recommended_qty, f.rule_reason
         FROM flags f JOIN skus s ON s.sku_id = f.sku_id
        WHERE f.run_id = $1 AND (f.is_exception OR cardinality(f.flag_types) > 0)
        ORDER BY f.sku_id`,
      [runId],
    );
    let next = 0, explained = 0;
    const errors = {};
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const r = await explainOne(recordForAi(row), { apiKey, model }, fetchFn);
        if (r.text) {
          await pool.query('UPDATE flags SET ai_reason = $1 WHERE id = $2', [r.text, row.id]);
          explained += 1;
        } else {
          errors[r.error] = (errors[r.error] || 0) + 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    const failed = rows.length - explained;
    return { state: rows.length && !explained ? 'failed' : 'ok', explained, failed, errors };
  } catch {
    return { state: 'failed', explained: 0, failed: 0, errors: { unexpected: 1 } };
  }
}
