// Multi-row upsert, shared by the seed script and the SAP upload.
export async function upsert(client, table, keys, cols, rows) {
  if (!rows.length) return;
  const updates = cols.filter((c) => !keys.includes(c));
  const set = updates.length
    ? `DO UPDATE SET ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
    : 'DO NOTHING';
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const tuples = chunk.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (${keys.join(', ')}) ${set}`,
      params,
    );
  }
}
