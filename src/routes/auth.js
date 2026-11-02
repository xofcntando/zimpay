const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { pool, withTx } = require('../db');
const { UserError, normPhone } = require('../money');
const { ensureUserAccounts } = require('../ledger');
const { wrap, flash } = require('./util');

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
router.get('/login', (req, res) => res.render('login'));
router.get('/register', (req, res) => res.render('register'));

router.post('/register', authLimiter, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  if (name.length < 2) throw new UserError('Enter your full name');
  if (password.length < 8) throw new UserError('Password must be at least 8 characters');
  const phone = normPhone(req.body.phone);
  const hash = await bcrypt.hash(password, 11);
  const role = cfg.adminPhone && normPhone(cfg.adminPhone) === phone ? 'admin' : 'user';
  try {
    const id = await withTx(async (c) => {
      const r = await c.query('INSERT INTO users(phone,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id', [phone, name, hash, role]);
      await ensureUserAccounts(c, r.rows[0].id);
      return r.rows[0].id;
    });
    await new Promise((ok) => req.session.regenerate(ok));
    req.session.userId = id;
    res.redirect('/dashboard');
  } catch (e) {
    if (e.code === '23505') throw new UserError('That number is already registered. Log in instead.');
    throw e;
  }
}));

router.post('/login', authLimiter, wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const u = (await pool.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0];
  // compare against a dummy hash when user missing to keep timing similar
  const ok = await bcrypt.compare(String(req.body.password || ''), u ? u.password_hash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok) throw new UserError('Wrong number or password');
  await new Promise((r) => req.session.regenerate(r));
  req.session.userId = u.id;
  res.redirect('/dashboard');
}));

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

module.exports = router;
