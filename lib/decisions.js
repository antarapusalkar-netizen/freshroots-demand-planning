// Checks a decision before it is saved. Pure: the flag row comes from the database.
// body: { flag_id, decision, override_qty, note }; flag: { is_exception, flag_types } or null.
export function validateDecision(body, flag) {
  if (!body || typeof body !== 'object') return { error: 'Missing request body.' };
  const flagId = Number(body.flag_id);
  if (!Number.isInteger(flagId) || flagId < 1) return { error: 'flag_id must be a number.' };
  if (!['approved', 'overridden'].includes(body.decision)) {
    return { error: 'decision must be "approved" or "overridden".' };
  }
  if (!flag) return { error: 'No such flag.' };
  if (!flag.is_exception && flag.flag_types.length === 0) {
    return { error: 'This SKU has no flag, so there is nothing to decide.' };
  }
  if (flag.is_exception && body.decision === 'approved') {
    return { error: 'Exceptions have no recommendation to approve. Use Override and enter what you want.' };
  }

  let qty = null;
  if (body.decision === 'overridden' && body.override_qty !== null && body.override_qty !== undefined && body.override_qty !== '') {
    if (!/^\d+$/.test(String(body.override_qty))) return { error: 'Quantity must be a whole number, 0 or more.' };
    qty = Number(body.override_qty);
  }
  let note = null;
  if (body.note !== null && body.note !== undefined && String(body.note).trim() !== '') {
    note = String(body.note).trim();
    if (note.length > 500) return { error: 'Note is too long (500 characters at most).' };
  }
  return { value: { flag_id: flagId, decision: body.decision, override_qty: qty, note } };
}
