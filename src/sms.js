// Auto-confirmation of manual EcoCash top-ups from the merchant phone's "money received" SMS.
// Match rule: the SMS must contain the customer's EcoCash reference AND the exact amount AND the right currency.
// Safety: SMS are stored once (hash-deduped), each SMS can confirm only one top-up, and amounts above
// AUTO_CONFIRM_MAX_* are left for an admin.
const crypto = require('crypto');
const { cols } = require('./db');
const L = require('./ledger');
const cfg = require('./config');

const norm = (s) => String(s || '').toUpperCase().replace(/[\s,]/g, '');
const currencyOk = (body, cur) => (cur === 'USD' ? /USD|US\$/i.test(body) : /ZWG|ZIG|ZWL/i.test(body));

function matches(body, tx) {
  if (!tx.provider_ref) return false;
  const ref = norm(tx.provider_ref);
  const b = norm(body);
  if (!b.includes(ref)) return false;
  const rest = b.split(ref).join(' '); // remove the reference so its digits can't be mistaken for the amount
  const amt = (tx.amount / 100).toFixed(2).replace('.', '\\.');
  if (!new RegExp(`(^|[^0-9.])${amt}(?![0-9])`).test(rest)) return false;
  return currencyOk(body, tx.currency);
}

async function confirmIfPossible(tx, sms) {
  if (tx.amount > cfg.autoConfirmMax[tx.currency]) return false;
  if (!matches(sms.body, tx)) return false;
  const claimed = await cols.sms_inbox.findOneAndUpdate({ _id: sms._id, used_tx: null }, { $set: { used_tx: tx._id } });
  if (!claimed) return false;
  await L.completeCashIn(tx._id);
  await cols.audit_log.insertOne({ actor_id: null, action: 'topup_auto_sms', detail: 'tx ' + tx._id, created_at: new Date() });
  return true;
}

// A forwarded SMS arrives
async function onSms({ body, sender }) {
  body = String(body || '').slice(0, 2000);
  if (!body) return { ignored: 'empty' };
  if (sender && !/ecocash/i.test(String(sender))) return { ignored: 'sender' };
  const doc = { body, sender: sender || null, hash: crypto.createHash('sha256').update(norm(body)).digest('hex'), received_at: new Date(), used_tx: null };
  try { doc._id = (await cols.sms_inbox.insertOne(doc)).insertedId; }
  catch (e) { if (e.code === 11000) return { duplicate: true }; throw e; }
  const pending = await cols.transactions.find({ type: 'cashin', status: 'pending', provider: 'manual' }).toArray();
  for (const tx of pending) if (await confirmIfPossible(tx, doc)) return { confirmed: String(tx._id) };
  return { stored: true };
}

// A customer submitted a reference; the SMS may already have arrived
async function onTopupSubmitted(txId) {
  const tx = await cols.transactions.findOne({ _id: require('./db').oid(txId), status: 'pending', provider: 'manual' });
  if (!tx) return false;
  const recent = await cols.sms_inbox.find({ used_tx: null, received_at: { $gte: new Date(Date.now() - 3 * 24 * 3600 * 1000) } }).toArray();
  for (const sms of recent) if (await confirmIfPossible(tx, sms)) return true;
  return false;
}

module.exports = { matches, onSms, onTopupSubmitted };
