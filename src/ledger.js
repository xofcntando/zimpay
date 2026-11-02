const { cols, withTx, oid } = require('./db');
const cfg = require('./config');
const { UserError, feeFor } = require('./money');

const uAcct = (userId, cur) => `u:${userId}:${cur}`;
const sAcct = (kind, cur) => `sys:${kind}:${cur}`;
const now = () => new Date();

function shapeTx(d) {
  if (!d) return d;
  return { ...d, id: String(d._id), initiator_id: String(d.initiator_id),
    counterparty_id: d.counterparty_id ? String(d.counterparty_id) : null };
}

async function ensureUserAccounts(session, userId) {
  for (const currency of cfg.currencies) {
    await cols.accounts.updateOne({ _id: uAcct(userId, currency) },
      { $setOnInsert: { user_id: oid(userId), kind: 'user', currency, balance: 0 } }, { upsert: true, session });
  }
}

// Applies legs (must sum to zero) atomically inside the caller's transaction.
// A debit on a user wallet only matches if balance >= amount, so wallets can never go negative.
async function applyLegs(s, txId, legs) {
  if (legs.reduce((a, l) => a + l.amount, 0) !== 0) throw new Error('unbalanced transaction');
  const merged = new Map();
  for (const l of legs) merged.set(l.accountId, (merged.get(l.accountId) || 0) + l.amount);
  for (const id of [...merged.keys()].sort()) {
    const amt = merged.get(id);
    const filter = { _id: id };
    const guarded = amt < 0 && id.startsWith('u:');
    if (guarded) filter.balance = { $gte: -amt };
    const r = await cols.accounts.updateOne(filter, { $inc: { balance: amt } }, { session: s });
    if (!r.matchedCount) throw guarded ? new UserError('Insufficient funds') : new Error('account missing ' + id);
    await cols.entries.insertOne({ transaction_id: txId, account_id: id, amount: amt, created_at: now() }, { session: s });
  }
}

async function dailyUsed(s, userId, currency) {
  const r = await cols.transactions.aggregate([
    { $match: { initiator_id: oid(userId), currency, type: { $in: ['transfer', 'cashout'] },
        status: { $in: ['pending', 'completed'] }, created_at: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
    { $group: { _id: null, used: { $sum: '$amount' } } },
  ], { session: s }).toArray();
  return r[0] ? r[0].used : 0;
}

async function checkLimits(s, user, currency, amount) {
  const lim = cfg.limits[user.kyc_status === 'verified' ? 'verified' : 'none'][currency];
  const hint = user.kyc_status !== 'verified' ? ' Verify your ID to raise limits.' : '';
  if (amount > lim.single) throw new UserError(`Per-transaction limit is ${lim.single / 100} ${currency}.` + hint);
  if ((await dailyUsed(s, user._id, currency)) + amount > lim.daily) throw new UserError(`Daily limit of ${lim.daily / 100} ${currency} reached.` + hint);
}

// Writing to the user's document makes concurrent transactions for the same user conflict and retry,
// so limits and balances can't be raced.
const lockUser = (s, userId) =>
  cols.users.findOneAndUpdate({ _id: oid(userId) }, { $inc: { lock_seq: 1 } }, { session: s, returnDocument: 'after' });

async function existingByIdem(s, userId, key) {
  if (!key) return null;
  return shapeTx(await cols.transactions.findOne({ initiator_id: oid(userId), idem_key: key }, { session: s }));
}

async function insertTx(s, f) {
  const doc = { fee: 0, counterparty_id: null, msisdn: null, note: null, provider: null, provider_ref: null,
    poll_url: null, idem_key: null, created_at: now(), updated_at: now(), ...f };
  doc._id = (await cols.transactions.insertOne(doc, { session: s })).insertedId;
  return doc;
}

// ---- P2P transfer (instant, internal) ----
async function transfer({ senderId, recipientPhone, currency, amount, note, idemKey }) {
  return withTx(async (s) => {
    const sender = await lockUser(s, senderId);
    const dup = await existingByIdem(s, senderId, idemKey);
    if (dup) return dup;
    if (!cfg.currencies.includes(currency)) throw new UserError('Unsupported currency');
    const rec = await cols.users.findOne({ phone: recipientPhone }, { session: s });
    if (!rec) throw new UserError('No account found for that number. Ask them to sign up first.');
    if (String(rec._id) === String(senderId)) throw new UserError("You can't send money to yourself");
    await checkLimits(s, sender, currency, amount);
    const fee = feeFor(amount, cfg.feeBps.transfer);
    const tx = await insertTx(s, { type: 'transfer', status: 'completed', currency, amount, fee,
      initiator_id: oid(senderId), counterparty_id: rec._id, note: note || null, idem_key: idemKey || null });
    const legs = [{ accountId: uAcct(senderId, currency), amount: -(amount + fee) }, { accountId: uAcct(rec._id, currency), amount }];
    if (fee) legs.push({ accountId: sAcct('fees', currency), amount: fee });
    await applyLegs(s, tx._id, legs);
    return shapeTx(tx);
  });
}

// ---- Cash in ----
async function createCashIn({ userId, currency, amount, msisdn, provider, idemKey, providerRef }) {
  return withTx(async (s) => {
    const dup = await existingByIdem(s, userId, idemKey);
    if (dup) return dup;
    if (!cfg.currencies.includes(currency)) throw new UserError('Unsupported currency');
    return shapeTx(await insertTx(s, { type: 'cashin', status: 'pending', currency, amount,
      initiator_id: oid(userId), msisdn, provider, provider_ref: providerRef || null, idem_key: idemKey || null }));
  });
}

async function setProviderInfo(txId, { providerRef, pollUrl }) {
  await cols.transactions.updateOne({ _id: oid(txId) },
    { $set: { provider_ref: providerRef || null, poll_url: pollUrl || null, updated_at: now() } });
}

// Idempotent: the status flip is claimed atomically, so it can only credit once.
async function completeCashIn(txId, providerRef) {
  return withTx(async (s) => {
    const claimed = await cols.transactions.findOneAndUpdate(
      { _id: oid(txId), type: 'cashin', status: 'pending' },
      { $set: { status: 'completed', updated_at: now(), ...(providerRef ? { provider_ref: providerRef } : {}) } },
      { session: s, returnDocument: 'after' });
    if (!claimed) return shapeTx(await cols.transactions.findOne({ _id: oid(txId) }, { session: s }));
    await applyLegs(s, claimed._id, [
      { accountId: sAcct('external', claimed.currency), amount: -claimed.amount },
      { accountId: uAcct(claimed.initiator_id, claimed.currency), amount: claimed.amount },
    ]);
    return shapeTx(claimed);
  });
}

async function failTx(txId) {
  return shapeTx(await cols.transactions.findOneAndUpdate({ _id: oid(txId), status: 'pending' },
    { $set: { status: 'failed', updated_at: now() } }, { returnDocument: 'after' }));
}

// ---- Cash out: funds sit in payout_hold until paid out or rejected ----
async function requestCashOut({ userId, currency, amount, msisdn, provider, idemKey }) {
  return withTx(async (s) => {
    const user = await lockUser(s, userId);
    const dup = await existingByIdem(s, userId, idemKey);
    if (dup) return dup;
    if (!cfg.currencies.includes(currency)) throw new UserError('Unsupported currency');
    if (user.kyc_status !== 'verified') throw new UserError('Verify your ID before withdrawing money.');
    await checkLimits(s, user, currency, amount);
    const fee = feeFor(amount, cfg.feeBps.cashout);
    const tx = await insertTx(s, { type: 'cashout', status: 'pending', currency, amount, fee,
      initiator_id: oid(userId), msisdn, provider, idem_key: idemKey || null });
    const legs = [{ accountId: uAcct(userId, currency), amount: -(amount + fee) }, { accountId: sAcct('payout_hold', currency), amount }];
    if (fee) legs.push({ accountId: sAcct('fees', currency), amount: fee });
    await applyLegs(s, tx._id, legs);
    return shapeTx(tx);
  });
}

async function resolveCashOut(txId, status, extra, legsFor) {
  return withTx(async (s) => {
    const tx = await cols.transactions.findOneAndUpdate(
      { _id: oid(txId), type: 'cashout', status: 'pending' },
      { $set: { status, updated_at: now(), ...extra } }, { session: s, returnDocument: 'after' });
    if (!tx) return shapeTx(await cols.transactions.findOne({ _id: oid(txId) }, { session: s }));
    await applyLegs(s, tx._id, legsFor(tx));
    return shapeTx(tx);
  });
}

const completeCashOut = (txId, providerRef) => resolveCashOut(txId, 'completed', providerRef ? { provider_ref: providerRef } : {}, (tx) => [
  { accountId: sAcct('payout_hold', tx.currency), amount: -tx.amount },
  { accountId: sAcct('external', tx.currency), amount: tx.amount },
]);

const rejectCashOut = (txId) => resolveCashOut(txId, 'rejected', {}, (tx) => {
  const legs = [
    { accountId: sAcct('payout_hold', tx.currency), amount: -tx.amount },
    { accountId: uAcct(tx.initiator_id, tx.currency), amount: tx.amount + tx.fee },
  ];
  if (tx.fee) legs.push({ accountId: sAcct('fees', tx.currency), amount: -tx.fee });
  return legs;
});

async function balances(userId) {
  const out = { USD: 0, ZWG: 0 };
  for (const a of await cols.accounts.find({ user_id: oid(userId) }).toArray()) out[a.currency] = a.balance;
  return out;
}

// ---- reads with counterparty names attached ----
async function withParties(txs) {
  const ids = [...new Set(txs.flatMap((t) => [t.initiator_id, t.counterparty_id].filter(Boolean).map(String)))].map(oid);
  const users = new Map((await cols.users.find({ _id: { $in: ids } }, { projection: { name: 1, phone: 1 } }).toArray()).map((u) => [String(u._id), u]));
  return txs.map((t) => {
    const i = users.get(String(t.initiator_id)) || {}, c = users.get(String(t.counterparty_id)) || {};
    return { ...shapeTx(t), init_name: i.name, init_phone: i.phone, cp_name: c.name, cp_phone: c.phone };
  });
}
async function listForUser(userId, limit = 25) {
  const u = oid(userId);
  return withParties(await cols.transactions.find({ $or: [{ initiator_id: u }, { counterparty_id: u }] }).sort({ created_at: -1 }).limit(limit).toArray());
}
async function getForUser(txId, userId) {
  const u = oid(userId);
  const t = await cols.transactions.findOne({ _id: oid(txId), $or: [{ initiator_id: u }, { counterparty_id: u }] });
  return t ? (await withParties([t]))[0] : null;
}
async function listAdmin(filter, limit = 30) {
  return withParties(await cols.transactions.find(filter).sort({ created_at: filter.status ? 1 : -1 }).limit(limit).toArray());
}

// Integrity: every tx nets to zero, each balance equals the sum of its entries, whole ledger nets to zero.
async function reconcile() {
  const unbalanced = (await cols.entries.aggregate([{ $group: { _id: '$transaction_id', s: { $sum: '$amount' } } }, { $match: { s: { $ne: 0 } } }, { $count: 'n' }]).toArray())[0]?.n || 0;
  const sums = new Map((await cols.entries.aggregate([{ $group: { _id: '$account_id', s: { $sum: '$amount' } } }]).toArray()).map((x) => [x._id, x.s]));
  const accts = await cols.accounts.find().toArray();
  const drift = accts.filter((a) => a.balance !== (sums.get(a._id) || 0)).length;
  const total = accts.reduce((a, x) => a + x.balance, 0);
  return { ok: unbalanced === 0 && drift === 0 && total === 0, unbalanced, drift, total };
}
async function books() {
  return cols.accounts.aggregate([{ $group: { _id: { kind: '$kind', currency: '$currency' }, balance: { $sum: '$balance' } } },
    { $project: { _id: 0, kind: '$_id.kind', currency: '$_id.currency', balance: 1 } }, { $sort: { kind: 1, currency: 1 } }]).toArray();
}

module.exports = {
  ensureUserAccounts, transfer, createCashIn, setProviderInfo, completeCashIn, failTx,
  requestCashOut, completeCashOut, rejectCashOut, balances, reconcile, books,
  listForUser, getForUser, listAdmin,
};
