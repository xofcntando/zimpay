const router = require('express').Router();
const L = require('../ledger');
const { cols, oid, isOid } = require('../db');
const { wrap, requireLogin, requireAdmin, flash } = require('./util');

router.use(requireLogin, requireAdmin);

router.get('/', wrap(async (req, res) => {
  const kyc = (await cols.users.find({ kyc_status: 'pending' }).sort({ created_at: 1 }).toArray()).map((u) => ({ ...u, id: String(u._id) }));
  const payouts = await L.listAdmin({ type: 'cashout', status: 'pending' }, 100);
  const recent = await L.listAdmin({}, 30);
  res.render('admin', { kyc, payouts, recent, books: await L.books(), rec: await L.reconcile() });
}));

const audit = (req, action, detail) => cols.audit_log.insertOne({ actor_id: oid(req.user.id), action, detail, created_at: new Date() });

router.post('/kyc/:id', wrap(async (req, res) => {
  if (!isOid(req.params.id)) return res.redirect('/admin');
  const status = req.body.decision === 'approve' ? 'verified' : 'rejected';
  await cols.users.updateOne({ _id: oid(req.params.id), kyc_status: 'pending' }, { $set: { kyc_status: status } });
  await audit(req, 'kyc_' + status, 'user ' + req.params.id);
  res.redirect('/admin');
}));

router.post('/payout/:id', wrap(async (req, res) => {
  if (!isOid(req.params.id)) return res.redirect('/admin');
  if (req.body.decision === 'approve') await L.completeCashOut(req.params.id, String(req.body.ref || '').slice(0, 80) || null);
  else await L.rejectCashOut(req.params.id);
  await audit(req, 'payout_' + req.body.decision, 'tx ' + req.params.id);
  flash(req, 'ok', 'Done.');
  res.redirect('/admin');
}));

module.exports = router;
