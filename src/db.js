const { Pool, types } = require('pg');
types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (minor units stay far below 2^53)
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.isProd && cfg.databaseUrl && !/localhost|127\.0\.0\.1|\.internal|render-postgres/.test(cfg.databaseUrl)
    ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, withTx };
