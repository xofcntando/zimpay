const router = require('express').Router();
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const sms = require('../sms');
const { wrap } = require('./util');

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pick = (o, keys) => { for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k]; };

// Point your SMS-forwarder app at: https://YOUR-SITE/webhooks/sms?key=SMS_WEBHOOK_SECRET
router.post('/webhooks/sms', limiter, express.json({ limit: '20kb' }), express.text({ limit: '20kb' }), wrap(async (req, res) => {
  if (!cfg.smsSecret) return res.sendStatus(404);
  const key = String(req.query.key || req.get('x-webhook-key') || '');
  if (!same(key, cfg.smsSecret)) return res.sendStatus(401);
  const b = typeof req.body === 'string' ? { message: req.body } : (req.body || {});
  const out = await sms.onSms({
    body: pick(b, ['message', 'text', 'body', 'content', 'msg', 'sms']),
    sender: pick(b, ['from', 'sender', 'address', 'number', 'phone']),
  });
  res.json({ ok: true, ...out });
}));

module.exports = router;
