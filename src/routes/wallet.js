const router = require('express').Router();
const cfg = require('../config');
const provider = require('../providers');
const L = require('../ledger');
const { pool } = require('../db');
const { UserError, parseAmount, normPhone } = require('../money');
const { wrap, requireLogin, flash } = require('./util');

const cur = (v) => { if (!cfg.currencies.includes(v)) throw new UserError('Choose USD or ZWG'); return v; };
const idem = (v) => String(v || '').slice(0, 64) || null;

router.get('/dashboard', requireLogin, wrap(async (req, res) => {
  const balances = await L.balances(req.user.id);
  const txs = (await pool.query(
    `SELECT t.*, i.name AS init_name, i.phone AS init_phone, c.name AS cp_name, c.phone AS cp_phone
     FROM transactions t JOIN users i ON i.id=t.initiator_id LEFT JOIN users c ON c.id=t.counterparty_id
     WHERE t.initiator_id=$1 OR t.counterparty_id=$1 ORDER BY t.created_at DESC LIMIT 25`, [req.user.id])).rows;
  res.render('dashboard', { balances, txs });
}));

const form = (view) => [requireLogin, (req, res) => res.render(view, { key: require('crypto').randomUUID() })];
router.get('/send', ...form('send'));
router.get('/topup', ...form('topup'));
router.get('/withdraw', ...form('withdraw'));

router.post('/send', requireLogin, wrap(async (req, res) => {
  const tx = await L.transfer({
    senderId: req.user.id, recipientPhone: normPhone(req.body.to), currency: cur(req.body.currency),
    amount: parseAmount(req.body.amount), note: String(req.body.note || '').slice(0, 140), idemKey: idem(req.body.key),
  });
  flash(req, 'ok', 'Money sent.');
  res.redirect('/tx/' + tx.id);
}));

router.post('/topup', requireLogin, wrap(async (req, res) => {
  const msisdn = normPhone(req.body.msisdn);
  const tx = await L.createCashIn({
    userId: req.user.id, currency: cur(req.body.currency), amount: parseAmount(req.body.amount),
    msisdn, provider: provider.name, idemKey: idem(req.body.key),
  });
  if (tx.status === 'pending' && !tx.provider_ref) {
    const r = await provider.initiateCashIn({ tx, user: req.user });
    if (r.status === 'failed') { await L.failTx(tx.id); throw new UserError(r.error || 'Payment could not be started'); }
    await L.setProviderInfo(tx.id, r);
    if (r.status === 'paid') await L.completeCashIn(tx.id, r.providerRef);
    else flash(req, 'ok', r.instructions || 'Approve the payment prompt on your phone.');
  }
  res.redirect('/tx/' + tx.id);
}));

router.post('/withdraw', requireLogin, wrap(async (req, res) => {
  const tx = await L.requestCashOut({
    userId: req.user.id, currency: cur(req.body.currency), amount: parseAmount(req.body.amount),
    msisdn: normPhone(req.body.msisdn), provider: provider.name, idemKey: idem(req.body.key),
  });
  if (provider.autoPayout && tx.status === 'pending') {
    const r = await provider.payout({ tx });
    await L.completeCashOut(tx.id, r.providerRef);
  } else if (tx.status === 'pending') {
    flash(req, 'ok', 'Withdrawal requested. It will be paid out after review.');
  }
  res.redirect('/tx/' + tx.id);
}));

router.get('/tx/:id', requireLogin, wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).render('error', { message: 'Not found' });
  let tx = (await pool.query(
    `SELECT t.*, i.name AS init_name, i.phone AS init_phone, c.name AS cp_name, c.phone AS cp_phone
     FROM transactions t JOIN users i ON i.id=t.initiator_id LEFT JOIN users c ON c.id=t.counterparty_id
     WHERE t.id=$1 AND (t.initiator_id=$2 OR t.counterparty_id=$2)`, [req.params.id, req.user.id])).rows[0];
  if (!tx) return res.status(404).render('error', { message: 'Not found' });
  // pending cash-ins: ask the provider for the current status whenever the user looks
  if (tx.type === 'cashin' && tx.status === 'pending' && provider.checkCashIn) {
    const r = await provider.checkCashIn({ tx });
    if (r.status === 'paid') { await L.completeCashIn(tx.id, r.providerRef); tx = { ...tx, status: 'completed' }; }
    else if (r.status === 'failed') { await L.failTx(tx.id); tx = { ...tx, status: 'failed' }; }
  }
  res.render('tx', { tx });
}));

router.get('/kyc', requireLogin, (req, res) => res.render('kyc'));
router.post('/kyc', requireLogin, wrap(async (req, res) => {
  const id = String(req.body.national_id || '').toUpperCase().replace(/[\s]/g, '');
  // Zimbabwe national ID format e.g. 63-123456-A-42 (digits, optional dashes, a letter, 2 digits)
  if (!/^\d{2}-?\d{6,7}-?[A-Z]-?\d{2}$/.test(id)) throw new UserError('Enter your ID like 63-123456-A-42');
  if (req.user.kyc_status === 'verified') throw new UserError('Already verified');
  await pool.query(`UPDATE users SET national_id=$2, kyc_status='pending' WHERE id=$1`, [req.user.id, id]);
  flash(req, 'ok', 'Submitted. An admin will review it.');
  res.redirect('/dashboard');
}));

// Paynow server-to-server callback. We never trust the body: verify hash, then re-poll Paynow.
router.post('/webhooks/paynow', require('express').urlencoded({ extended: false }), wrap(async (req, res) => {
  if (provider.name !== 'paynow') return res.sendStatus(404);
  if (!provider.verify(req.body)) return res.sendStatus(400);
  const tx = (await pool.query('SELECT * FROM transactions WHERE id=$1', [String(req.body.reference)])).rows[0];
  if (tx && tx.status === 'pending') {
    const r = await provider.checkCashIn({ tx });
    if (r.status === 'paid') await L.completeCashIn(tx.id, r.providerRef);
    else if (r.status === 'failed') await L.failTx(tx.id);
  }
  res.sendStatus(200);
}));

module.exports = router;
