const router = require('express').Router();
const cfg = require('../config');
const provider = require('../providers');
const L = require('../ledger');
const smsAuto = require('../sms');
const { cols, oid, isOid } = require('../db');
const { UserError, parseAmount, normPhone } = require('../money');
const { wrap, requireLogin, flash } = require('./util');

const cur = (v) => { if (!cfg.currencies.includes(v)) throw new UserError('Choose USD or ZWG'); return v; };
const idem = (v) => String(v || '').slice(0, 64) || null;

router.get('/dashboard', requireLogin, wrap(async (req, res) => {
  res.render('dashboard', { balances: await L.balances(req.user.id), txs: await L.listForUser(req.user.id, 25) });
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
  let providerRef;
  if (provider.name === 'manual') {
    providerRef = String(req.body.ref || '').trim().toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z0-9.]{6,30}$/.test(providerRef)) throw new UserError('Enter the EcoCash reference from your confirmation SMS');
  }
  let tx;
  try {
    tx = await L.createCashIn({
      userId: req.user.id, currency: cur(req.body.currency), amount: parseAmount(req.body.amount),
      msisdn, provider: provider.name, idemKey: idem(req.body.key), providerRef,
    });
  } catch (e) {
    if (e.code === 11000) throw new UserError('That EcoCash reference was already submitted.');
    throw e;
  }
  if (provider.name === 'manual') {
    const auto = tx.status === 'pending' && cfg.smsSecret && (await smsAuto.onTopupSubmitted(tx.id));
    flash(req, 'ok', auto ? 'Payment confirmed. Your balance is updated.' : 'Received. Your balance updates once we confirm the EcoCash payment.');
  }
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
  if (!isOid(req.params.id)) return res.status(404).render('error', { message: 'Not found' });
  let tx = await L.getForUser(req.params.id, req.user.id);
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
  await cols.users.updateOne({ _id: oid(req.user.id) }, { $set: { national_id: id, kyc_status: 'pending' } });
  flash(req, 'ok', 'Submitted. An admin will review it.');
  res.redirect('/dashboard');
}));

// Paynow server-to-server callback. We never trust the body: verify hash, then re-poll Paynow.
router.post('/webhooks/paynow', require('express').urlencoded({ extended: false }), wrap(async (req, res) => {
  if (provider.name !== 'paynow') return res.sendStatus(404);
  if (!provider.verify(req.body)) return res.sendStatus(400);
  const ref = String(req.body.reference);
  const raw = isOid(ref) ? await cols.transactions.findOne({ _id: oid(ref) }) : null;
  const tx = raw && { ...raw, id: String(raw._id) };
  if (tx && tx.status === 'pending') {
    const r = await provider.checkCashIn({ tx });
    if (r.status === 'paid') await L.completeCashIn(tx.id, r.providerRef);
    else if (r.status === 'failed') await L.failTx(tx.id);
  }
  res.sendStatus(200);
}));

module.exports = router;
