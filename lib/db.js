import pg from 'pg';

// DATABASE_URL comes from .env (or Vercel env vars). Never print it.
export function connect() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Put it in .env (see .env.example).');
  }
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
}

// Opens a pool for one request and always closes it.
export async function withPool(fn) {
  const pool = connect();
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
