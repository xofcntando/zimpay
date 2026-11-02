const router = require('express').Router();
const L = require('../ledger');
const { pool } = require('../db');
const { wrap, requireLogin, requireAdmin, flash } = require('./util');

router.use(requireLogin, requireAdmin);

router.get('/', wrap(async (req, res) => {
  const kyc = (await pool.query(`SELECT id,name,phone,national_id,created_at FROM users WHERE kyc_status='pending' ORDER BY created_at`)).rows;
  const payouts = (await pool.query(
    `SELECT t.*, u.name, u.phone FROM transactions t JOIN users u ON u.id=t.initiator_id
     WHERE t.type='cashout' AND t.status='pending' ORDER BY t.created_at`)).rows;
  const recent = (await pool.query(
    `SELECT t.*, u.phone FROM transactions t JOIN users u ON u.id=t.initiator_id ORDER BY t.created_at DESC LIMIT 30`)).rows;
  const books = (await pool.query(`SELECT kind, currency, SUM(balance)::bigint AS balance FROM accounts GROUP BY 1,2 ORDER BY 1,2`)).rows;
  res.render('admin', { kyc, payouts, recent, books, rec: await L.reconcile() });
}));

const audit = (req, action, detail) => pool.query('INSERT INTO audit_log(actor_id,action,detail) VALUES ($1,$2,$3)', [req.user.id, action, detail]);

router.post('/kyc/:id', wrap(async (req, res) => {
  const status = req.body.decision === 'approve' ? 'verified' : 'rejected';
  await pool.query(`UPDATE users SET kyc_status=$2 WHERE id=$1 AND kyc_status='pending'`, [Number(req.params.id), status]);
  await audit(req, 'kyc_' + status, 'user ' + req.params.id);
  res.redirect('/admin');
}));

router.post('/payout/:id', wrap(async (req, res) => {
  if (req.body.decision === 'approve') await L.completeCashOut(req.params.id, String(req.body.ref || '').slice(0, 80) || null);
  else await L.rejectCashOut(req.params.id);
  await audit(req, 'payout_' + req.body.decision, 'tx ' + req.params.id);
  flash(req, 'ok', 'Done.');
  res.redirect('/admin');
}));

module.exports = router;
