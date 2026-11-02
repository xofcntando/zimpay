const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb } = require('./helpers');

let pg, server, base, L, db;

before(async () => {
  pg = await startDb();
  db = require('../src/db'); await db.init(process.env.MONGODB_URI, 'zimpay_test');
  L = require('../src/ledger');
  const { createApp } = require('../src/server');
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
});
after(async () => { server && server.close(); await db.close(); await pg.stop(); });

// minimal cookie-aware client
function client() {
  let cookie = '';
  const req = async (method, url, form) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return { res, text: await res.text() };
  };
  const csrf = async (url) => (await req('GET', url)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { req, csrf };
}

async function signup(name, phone) {
  const c = client();
  const t = await c.csrf('/register');
  const r = await c.req('POST', '/register', { _csrf: t, name, phone, password: 'password123' });
  assert.equal(r.res.status, 302, r.text);
  return c;
}
const uid = async (phone) => String((await db.cols.users.findOne({ phone }))._id);

test('rejects POST without CSRF token', async () => {
  const c = client(); await c.req('GET', '/login');
  const r = await c.req('POST', '/login', { phone: '0771111111', password: 'x' });
  assert.equal(r.res.status, 403);
});

test('signup, top up, transfer, ledger stays balanced', async () => {
  const alice = await signup('Alice', '0771000001');
  await signup('Bob', '0771000002');
  const a = await uid('+263771000001'), b = await uid('+263771000002');

  let t = await alice.csrf('/topup');
  let r = await alice.req('POST', '/topup', { _csrf: t, msisdn: '0771000001', amount: '30.00', currency: 'USD', key: 'k1' });
  assert.equal(r.res.status, 302);
  assert.equal((await L.balances(a)).USD, 3000);

  // double submit of same idempotency key must not double-credit
  await alice.req('POST', '/topup', { _csrf: t, msisdn: '0771000001', amount: '30.00', currency: 'USD', key: 'k1' });
  assert.equal((await L.balances(a)).USD, 3000);

  t = await alice.csrf('/send');
  r = await alice.req('POST', '/send', { _csrf: t, to: '0771000002', amount: '12.50', currency: 'USD', key: 's1' });
  assert.equal(r.res.status, 302);
  await alice.req('POST', '/send', { _csrf: t, to: '0771000002', amount: '12.50', currency: 'USD', key: 's1' }); // replay
  assert.equal((await L.balances(a)).USD, 1750);
  assert.equal((await L.balances(b)).USD, 1250);

  assert.equal((await L.reconcile()).ok, true);
});

test('cannot overdraw, cannot send to self, per-transaction limit for unverified', async () => {
  const c = await signup('Carol', '0771000003');
  const id = await uid('+263771000003');
  await L.createCashIn({ userId: id, currency: 'USD', amount: 4000, msisdn: '+263771000003', provider: 'mock' })
    .then((tx) => L.completeCashIn(tx.id));
  await assert.rejects(L.transfer({ senderId: id, recipientPhone: '+263771000002', currency: 'USD', amount: 4500 }), /Insufficient|limit/);
  await assert.rejects(L.transfer({ senderId: id, recipientPhone: '+263771000003', currency: 'USD', amount: 100 }), /yourself/);
  await assert.rejects(L.transfer({ senderId: id, recipientPhone: '+263771000002', currency: 'USD', amount: 6000 }), /limit/);
  assert.equal((await L.balances(id)).USD, 4000);
});

test('concurrent spends cannot overdraw', async () => {
  const id = await uid('+263771000003'); // has 40.00
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    L.transfer({ senderId: id, recipientPhone: '+263771000002', currency: 'USD', amount: 1500 })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 2); // 2 x 15 = 30 <= 40 < 45
  assert.equal((await L.balances(id)).USD, 1000);
  assert.equal((await L.reconcile()).ok, true);
});

test('withdrawal needs KYC; admin approves; reject refunds incl. fee', async () => {
  const id = await uid('+263771000001');
  await assert.rejects(L.requestCashOut({ userId: id, currency: 'USD', amount: 500, msisdn: '+263771000001', provider: 'x' }), /Verify/);
  await db.cols.users.updateOne({ _id: db.oid(id) }, { $set: { kyc_status: 'verified' } });
  const before = (await L.balances(id)).USD;
  const tx = await L.requestCashOut({ userId: id, currency: 'USD', amount: 1000, msisdn: '+263771000001', provider: 'x' });
  assert.equal(tx.fee, 10); // 1%
  assert.equal((await L.balances(id)).USD, before - 1010);
  await L.rejectCashOut(tx.id);
  assert.equal((await L.balances(id)).USD, before);
  const tx2 = await L.requestCashOut({ userId: id, currency: 'USD', amount: 1000, msisdn: '+263771000001', provider: 'x' });
  await L.completeCashOut(tx2.id, 'REF1');
  await L.completeCashOut(tx2.id, 'REF1'); // idempotent
  assert.equal((await L.balances(id)).USD, before - 1010);
  assert.equal((await L.reconcile()).ok, true);
});

test('admin area hidden from normal users, visible to ADMIN_PHONE', async () => {
  const bob = client(); const t = await bob.csrf('/login');
  await bob.req('POST', '/login', { _csrf: t, phone: '0771000002', password: 'password123' });
  assert.equal((await bob.req('GET', '/admin')).res.status, 404);
  const admin = await signup('Admin', '0770000000');
  const r = await admin.req('GET', '/admin');
  assert.equal(r.res.status, 200); assert.match(r.text, /Ledger integrity: <b>OK/);
});

test('manual EcoCash top-up: reference is single-use, admin approval credits once', async () => {
  const id = await uid('+263771000002');
  const before = (await L.balances(id)).USD;
  const tx = await L.createCashIn({ userId: id, currency: 'USD', amount: 2500, msisdn: '+263771000002', provider: 'manual', providerRef: 'MP1234.ABC' });
  assert.equal(tx.status, 'pending');
  await assert.rejects(L.createCashIn({ userId: id, currency: 'USD', amount: 2500, msisdn: '+263771000002', provider: 'manual', providerRef: 'MP1234.ABC' }), (e) => e.code === 11000);
  assert.equal((await L.balances(id)).USD, before);
  await Promise.all([L.completeCashIn(tx.id), L.completeCashIn(tx.id)]);
  assert.equal((await L.balances(id)).USD, before + 2500);
  assert.equal((await L.reconcile()).ok, true);
  const admin = client(); const t = await admin.csrf('/login');
  await admin.req('POST', '/login', { _csrf: t, phone: '0770000000', password: 'password123' });
  const tx2 = await L.createCashIn({ userId: id, currency: 'USD', amount: 100, msisdn: '+263771000002', provider: 'manual', providerRef: 'MP9999.XYZ' });
  const page = await admin.req('GET', '/admin'); assert.match(page.text, /Pending EcoCash top-ups \(1\)/);
  const t2 = await admin.csrf('/admin');
  await admin.req('POST', '/admin/topup/' + tx2.id, { _csrf: t2, decision: 'approve' });
  assert.equal((await L.balances(id)).USD, before + 2600);
});

test('SMS auto-confirm: matches ref+amount+currency, either order, once, respects cap', async () => {
  const cfg = require('../src/config'); cfg.smsSecret = 'sek';
  const sms = require('../src/sms');
  const id = await uid('+263771000002'); const before = (await L.balances(id)).USD;
  const mk = (ref, amount) => L.createCashIn({ userId: id, currency: 'USD', amount, msisdn: '+263771000002', provider: 'manual', providerRef: ref });
  const text = (ref, amt) => `Confirmed. You have received USD ${amt} from 0771000002 - TEST. Ref: ${ref}. New balance USD 99.00`;

  // SMS first, then customer submits
  assert.deepEqual(await sms.onSms({ body: text('MP777.AAA.B1', '12.00'), sender: 'EcoCash' }), { stored: true });
  const t1 = await mk('MP777.AAA.B1', 1200);
  assert.equal(await sms.onTopupSubmitted(t1.id), true);
  assert.equal((await L.balances(id)).USD, before + 1200);

  // customer first, SMS second
  const t2 = await mk('MP888.CCC.D2', 500);
  const r = await sms.onSms({ body: text('MP888.CCC.D2', '5.00'), sender: 'EcoCash' });
  assert.equal(r.confirmed, t2.id);
  assert.equal((await L.balances(id)).USD, before + 1700);

  // replayed SMS does nothing
  assert.equal((await sms.onSms({ body: text('MP888.CCC.D2', '5.00'), sender: 'EcoCash' })).duplicate, true);
  // wrong amount, wrong currency, wrong sender, over cap: all stay pending
  const t3 = await mk('MP999.EEE.F3', 1000);
  await sms.onSms({ body: text('MP999.EEE.F3', '9.00'), sender: 'EcoCash' });
  await sms.onSms({ body: text('MP999.EEE.F3', '10.00').replaceAll('USD', 'ZWG'), sender: 'EcoCash' });
  assert.equal((await sms.onSms({ body: text('MP999.EEE.F3', '10.00'), sender: 'Scammer' })).ignored, 'sender');
  const t4 = await mk('MP555.GGG.H4', 600000);
  await sms.onSms({ body: text('MP555.GGG.H4', '6000.00'), sender: 'EcoCash' });
  assert.equal((await L.balances(id)).USD, before + 1700);
  assert.equal((await db.cols.transactions.findOne({ _id: db.oid(t3.id) })).status, 'pending');
  assert.equal((await db.cols.transactions.findOne({ _id: db.oid(t4.id) })).status, 'pending');
  assert.equal((await L.reconcile()).ok, true);

  // HTTP webhook auth
  const bad = await fetch(base + '/webhooks/sms?key=nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"x"}' });
  assert.equal(bad.status, 401);
  const good = await fetch(base + '/webhooks/sms?key=sek', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text('MP999.EEE.F3', '10.00'), from: 'EcoCash' }) });
  assert.equal((await good.json()).confirmed, t3.id);
  assert.equal((await L.balances(id)).USD, before + 2700);
  cfg.smsSecret = '';
});
