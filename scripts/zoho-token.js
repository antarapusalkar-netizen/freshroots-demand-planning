// One-time helper: turns the code from the Zoho API console (Self Client) into a refresh token.
// Reads ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_CODE and ZOHO_DC from .env, then writes
// ZOHO_REFRESH_TOKEN into .env and removes ZOHO_CODE. It never prints any of the values.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DATA_CENTERS } from '../lib/zoho-config.js';

export function updateEnvText(text, refreshToken) {
  const lines = text.split('\n').filter((l) => !/^ZOHO_CODE=/.test(l) && !/^ZOHO_REFRESH_TOKEN=/.test(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`ZOHO_REFRESH_TOKEN=${refreshToken}`);
  return lines.join('\n') + '\n';
}

export async function exchangeCode(env, fetchFn = fetch) {
  for (const k of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_CODE']) {
    if (!env[k]) throw new Error(`${k} is not set in .env`);
  }
  const dc = env.ZOHO_DC || 'in';
  if (!DATA_CENTERS.includes(dc)) throw new Error(`ZOHO_DC must be one of: ${DATA_CENTERS.join(', ')}`);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    code: env.ZOHO_CODE,
  });
  const res = await fetchFn(`https://accounts.zoho.${dc}/oauth/v2/token`, { method: 'POST', body, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!json.refresh_token) {
    throw new Error(`Zoho did not return a refresh token${json.error ? `: ${json.error}` : ` (HTTP ${res.status})`}. The code works once and expires after about 10 minutes; generate a new one.`);
  }
  return json.refresh_token;
}

async function main() {
  const envPath = new URL('../.env', import.meta.url);
  const token = await exchangeCode(process.env);
  writeFileSync(envPath, updateEnvText(readFileSync(envPath, 'utf8'), token));
  console.log('Done. The refresh token was saved to .env (not shown) and ZOHO_CODE was removed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Failed: ${e.message}`); process.exit(1); });
}
