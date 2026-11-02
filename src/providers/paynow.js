// Paynow Zimbabwe (https://developers.paynow.co.zw) mobile express checkout for CASH-IN only.
// UNTESTED against live Paynow: verify in Paynow's integration sandbox before real use.
// Paynow does not offer a general payout API, so cash-outs stay in the admin queue (manual or via your licensed partner).
const crypto = require('crypto');
const cfg = require('../config');

const INIT = 'https://www.paynow.co.zw/interface/remotetransaction';

function hash(values, key) {
  return crypto.createHash('sha512').update(values.join('') + key).digest('hex').toUpperCase();
}
function parse(body) {
  return Object.fromEntries(new URLSearchParams(body));
}
function verify(fields) {
  const { hash: h, ...rest } = fields;
  const vals = Object.entries(rest).map(([, v]) => v); // order as received
  return h && hash(vals, cfg.paynow.key) === h.toUpperCase();
}

module.exports = {
  name: 'paynow',
  autoPayout: false,
  verify, parse,
  async initiateCashIn({ tx, user }) {
    const method = 'ecocash'; // also supports onemoney / innbucks via different flows
    const fields = {
      id: cfg.paynow.id,
      reference: tx.id,
      amount: (Number(tx.amount) / 100).toFixed(2),
      additionalinfo: 'Wallet top-up',
      returnurl: `${cfg.baseUrl}/tx/${tx.id}`,
      resulturl: `${cfg.baseUrl}/webhooks/paynow`,
      authemail: cfg.paynow.authEmail,
      phone: tx.msisdn.replace('+263', '0'),
      method,
      status: 'Message',
    };
    fields.hash = hash(Object.values(fields), cfg.paynow.key); // hash covers all values in order, before 'hash' is added
    const res = await fetch(INIT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const out = parse(await res.text());
    if (!verify(out) && out.status && out.status.toLowerCase() !== 'error') throw new Error('Paynow response failed hash check');
    if ((out.status || '').toLowerCase() === 'error') return { status: 'failed', error: out.error };
    return { status: 'pending', providerRef: out.paynowreference, pollUrl: out.pollurl, instructions: out.instructions };
  },
  async checkCashIn({ tx }) {
    if (!tx.poll_url) return { status: 'pending' };
    const out = parse(await (await fetch(tx.poll_url, { method: 'POST' })).text());
    if (!verify(out)) throw new Error('Paynow poll failed hash check');
    const s = (out.status || '').toLowerCase();
    if (s === 'paid' || s === 'delivered') return { status: 'paid', providerRef: out.paynowreference };
    if (['cancelled', 'failed', 'disputed', 'refunded'].includes(s)) return { status: 'failed' };
    return { status: 'pending' };
  },
};
