const { withTx } = require('./db');
const cfg = require('./config');
const { UserError, feeFor } = require('./money');

async function ensureUserAccounts(client, userId) {
  for (const c of cfg.currencies) {
    await client.query(
      'INSERT INTO accounts(user_id,kind,currency) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, 'user', c]);
  }
}

async function acct(client, userId, currency) {
  const r = await client.query('SELECT id FROM accounts WHERE user_id=$1 AND currency=$2', [userId, currency]);
  if (!r.rows[0]) throw new Error('wallet missing');
  return r.rows[0].id;
}
async function sysAcct(client, kind, currency) {
  const r = await client.query('SELECT id FROM accounts WHERE user_id IS NULL AND kind=$1 AND currency=$2', [kind, currency]);
  return r.rows[0].id;
}

// Applies legs (must sum to zero) atomically. Locks accounts in id order to avoid deadlocks.
async function applyLegs(client, txId, legs) {
  const sum = legs.reduce((a, l) => a + l.amount, 0);
  if (sum !== 0) throw new Error('unbalanced transaction');
  const merged = new Map();
  for (const l of legs) merged.set(l.accountId, (merged.get(l.accountId) || 0) + l.amount);
  const ids = [...merged.keys()].sort((a, b) => a - b);
  await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
  for (const id of ids) {
    try {
      await client.query('UPDATE accounts SET balance = balance + $1 WHERE id=$2', [merged.get(id), id]);
    } catch (e) {
      if (e.code === '23514') throw new UserError('Insufficient funds');
      throw e;
    }
    await client.query('INSERT INTO entries(transaction_id,account_id,amount) VALUES ($1,$2,$3)', [txId, id, merged.get(id)]);
  }
}

async function dailyUsed(client, userId, currency) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount),0)::bigint AS used FROM transactions
     WHERE initiator_id=$1 AND currency=$2 AND type IN ('transfer','cashout')
       AND status IN ('pending','completed') AND created_at >= now() - interval '24 hours'`, [userId, currency]);
  return Number(r.rows[0].used);
}

async function checkLimits(client, user, currency, amount) {
  const lim = cfg.limits[user.kyc_status === 'verified' ? 'verified' : 'none'][currency];
  if (amount > lim.single) throw new UserError(
    `Per-transaction limit is ${lim.single / 100} ${currency}.` + (user.kyc_status !== 'verified' ? ' Verify your ID to raise limits.' : ''));
  const used = await dailyUsed(client, user.id, currency);
  if (used + amount > lim.daily) throw new UserError(
    `Daily limit of ${lim.daily / 100} ${currency} reached.` + (user.kyc_status !== 'verified' ? ' Verify your ID to raise limits.' : ''));
}

async function lockUser(client, userId) {
  const r = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
  return r.rows[0];
}

function isUnique(e) { return e && e.code === '23505'; }

async function existingByIdem(client, userId, key) {
  if (!key) return null;
  const r = await client.query('SELECT * FROM transactions WHERE initiator_id=$1 AND idem_key=$2', [userId, key]);
  return r.rows[0] || null;
}

// ---- P2P transfer (instant, internal) ----
async function transfer({ senderId, recipientPhone, currency, amount, note, idemKey }) {
  return withTx(async (c) => {
    const sender = await lockUser(c, senderId); // serialises a user's own spending => limits can't be raced
    const dup = await existingByIdem(c, senderId, idemKey);
    if (dup) return dup;
    if (!cfg.currencies.includes(currency)) throw new UserError('Unsupported currency');
    const rec = (await c.query('SELECT * FROM users WHERE phone=$1', [recipientPhone])).rows[0];
    if (!rec) throw new UserError('No account found for that number. Ask them to sign up first.');
    if (rec.id === senderId) throw new UserError("You can't send money to yourself");
    await checkLimits(c, sender, currency, amount);
    const fee = feeFor(amount, cfg.feeBps.transfer);
    const tx = (await c.query(
      `INSERT INTO transactions(type,status,currency,amount,fee,initiator_id,counterparty_id,note,idem_key)
       VALUES ('transfer','completed',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [currency, amount, fee, senderId, rec.id, note || null, idemKey || null])).rows[0];
    const legs = [
      { accountId: await acct(c, senderId, currency), amount: -(amount + fee) },
      { accountId: await acct(c, rec.id, currency), amount },
    ];
    if (fee) legs.push({ accountId: await sysAcct(c, 'fees', currency), amount: fee });
    await applyLegs(c, tx.id, legs);
    return tx;
  });
}

// ---- Cash in ----
async function createCashIn({ userId, currency, amount, msisdn, provider, idemKey }) {
  return withTx(async (c) => {
    const dup = await existingByIdem(c, userId, idemKey);
    if (dup) return dup;
    return (await c.query(
      `INSERT INTO transactions(type,status,currency,amount,initiator_id,msisdn,provider,idem_key)
       VALUES ('cashin','pending',$1,$2,$3,$4,$5,$6) RETURNING *`,
      [currency, amount, userId, msisdn, provider, idemKey || null])).rows[0];
  });
}

async function setProviderInfo(txId, { providerRef, pollUrl }) {
  await require('./db').pool.query(
    'UPDATE transactions SET provider_ref=$2, poll_url=$3, updated_at=now() WHERE id=$1', [txId, providerRef || null, pollUrl || null]);
}

// Idempotent: only credits once, only if still pending.
async function completeCashIn(txId, providerRef) {
  return withTx(async (c) => {
    const tx = (await c.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId])).rows[0];
    if (!tx || tx.type !== 'cashin' || tx.status !== 'pending') return tx;
    await applyLegs(c, tx.id, [
      { accountId: await sysAcct(c, 'external', tx.currency), amount: -tx.amount },
      { accountId: await acct(c, tx.initiator_id, tx.currency), amount: tx.amount },
    ]);
    return (await c.query(
      `UPDATE transactions SET status='completed', provider_ref=COALESCE($2,provider_ref), updated_at=now() WHERE id=$1 RETURNING *`,
      [txId, providerRef || null])).rows[0];
  });
}

async function failTx(txId) {
  const r = await require('./db').pool.query(
    `UPDATE transactions SET status='failed', updated_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [txId]);
  return r.rows[0];
}

// ---- Cash out: funds move to payout_hold until paid out or rejected ----
async function requestCashOut({ userId, currency, amount, msisdn, provider, idemKey }) {
  return withTx(async (c) => {
    const user = await lockUser(c, userId);
    const dup = await existingByIdem(c, userId, idemKey);
    if (dup) return dup;
    if (!cfg.currencies.includes(currency)) throw new UserError('Unsupported currency');
    if (user.kyc_status !== 'verified') throw new UserError('Verify your ID before withdrawing money.');
    await checkLimits(c, user, currency, amount);
    const fee = feeFor(amount, cfg.feeBps.cashout);
    const tx = (await c.query(
      `INSERT INTO transactions(type,status,currency,amount,fee,initiator_id,msisdn,provider,idem_key)
       VALUES ('cashout','pending',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [currency, amount, fee, userId, msisdn, provider, idemKey || null])).rows[0];
    const legs = [
      { accountId: await acct(c, userId, currency), amount: -(amount + fee) },
      { accountId: await sysAcct(c, 'payout_hold', currency), amount },
    ];
    if (fee) legs.push({ accountId: await sysAcct(c, 'fees', currency), amount: fee });
    await applyLegs(c, tx.id, legs);
    return tx;
  });
}

async function completeCashOut(txId, providerRef) {
  return withTx(async (c) => {
    const tx = (await c.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId])).rows[0];
    if (!tx || tx.type !== 'cashout' || tx.status !== 'pending') return tx;
    await applyLegs(c, tx.id, [
      { accountId: await sysAcct(c, 'payout_hold', tx.currency), amount: -tx.amount },
      { accountId: await sysAcct(c, 'external', tx.currency), amount: tx.amount },
    ]);
    return (await c.query(
      `UPDATE transactions SET status='completed', provider_ref=COALESCE($2,provider_ref), updated_at=now() WHERE id=$1 RETURNING *`,
      [txId, providerRef || null])).rows[0];
  });
}

async function rejectCashOut(txId) {
  return withTx(async (c) => {
    const tx = (await c.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId])).rows[0];
    if (!tx || tx.type !== 'cashout' || tx.status !== 'pending') return tx;
    const legs = [
      { accountId: await sysAcct(c, 'payout_hold', tx.currency), amount: -tx.amount },
      { accountId: await acct(c, tx.initiator_id, tx.currency), amount: tx.amount + Number(tx.fee) },
    ];
    if (Number(tx.fee)) legs.push({ accountId: await sysAcct(c, 'fees', tx.currency), amount: -Number(tx.fee) });
    await applyLegs(c, tx.id, legs);
    return (await c.query(`UPDATE transactions SET status='rejected', updated_at=now() WHERE id=$1 RETURNING *`, [txId])).rows[0];
  });
}

async function balances(userId) {
  const r = await require('./db').pool.query(
    `SELECT currency, balance FROM accounts WHERE user_id=$1`, [userId]);
  const out = { USD: 0, ZWG: 0 };
  r.rows.forEach((x) => (out[x.currency] = Number(x.balance)));
  return out;
}

// Integrity check: every transaction nets to zero, balances equal sum of entries, whole ledger nets to zero.
async function reconcile() {
  const q = (s) => require('./db').pool.query(s);
  const unbalanced = (await q(`SELECT count(*)::int n FROM (SELECT transaction_id FROM entries GROUP BY 1 HAVING SUM(amount)<>0) x`)).rows[0].n;
  const drift = (await q(`SELECT count(*)::int n FROM accounts a WHERE a.balance <> COALESCE((SELECT SUM(amount) FROM entries e WHERE e.account_id=a.id),0)`)).rows[0].n;
  const total = Number((await q(`SELECT COALESCE(SUM(balance),0)::bigint s FROM accounts`)).rows[0].s);
  return { ok: unbalanced === 0 && drift === 0 && total === 0, unbalanced, drift, total };
}

module.exports = {
  ensureUserAccounts, transfer, createCashIn, setProviderInfo, completeCashIn, failTx,
  requestCashOut, completeCashOut, rejectCashOut, balances, reconcile, isUnique,
};
