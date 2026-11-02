const { MongoClient, ObjectId } = require('mongodb');
const cfg = require('./config');

const cols = {};
let client;

async function init(uri = cfg.mongoUri, dbName = cfg.dbName) {
  if (!uri) throw new Error('MONGODB_URI is not set');
  client = new MongoClient(uri, { retryWrites: true, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const n of ['users', 'accounts', 'transactions', 'entries', 'audit_log']) {
    if (!existing.has(n)) await db.createCollection(n).catch((e) => { if (e.code !== 48) throw e; });
    cols[n] = db.collection(n);
  }
  await cols.users.createIndex({ phone: 1 }, { unique: true });
  await cols.transactions.createIndex({ initiator_id: 1, idem_key: 1 },
    { unique: true, partialFilterExpression: { idem_key: { $type: 'string' } } });
  // an EcoCash reference can only be claimed once (manual top-ups)
  await cols.transactions.createIndex({ provider_ref: 1 },
    { unique: true, partialFilterExpression: { provider: 'manual', type: 'cashin', provider_ref: { $type: 'string' } } });
  await cols.transactions.createIndex({ initiator_id: 1, created_at: -1 });
  await cols.transactions.createIndex({ counterparty_id: 1, created_at: -1 });
  await cols.entries.createIndex({ transaction_id: 1 });
  await cols.entries.createIndex({ account_id: 1 });
  // system accounts: deterministic ids, money held at bank/provider (goes negative), fees, payout hold
  for (const kind of ['external', 'fees', 'payout_hold']) {
    for (const currency of cfg.currencies) {
      await cols.accounts.updateOne({ _id: `sys:${kind}:${currency}` },
        { $setOnInsert: { user_id: null, kind, currency, balance: 0 } }, { upsert: true });
    }
  }
  return db;
}

// Runs fn(session) in a multi-document transaction (needs a replica set; Atlas always is). Retries transient conflicts.
async function withTx(fn) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}

const oid = (s) => (s instanceof ObjectId ? s : new ObjectId(String(s)));
const isOid = (s) => /^[0-9a-f]{24}$/i.test(String(s));
const getClient = () => client;
const close = () => client && client.close();

module.exports = { cols, init, withTx, oid, isOid, getClient, close, ObjectId };
