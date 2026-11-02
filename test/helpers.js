const EmbeddedPostgres = require('embedded-postgres').default;
const fs = require('fs'); const os = require('os'); const path = require('path');

async function startDb(port = 54329) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false });
  await pg.initialise(); await pg.start();
  process.env.DATABASE_URL = `postgres://postgres:pw@localhost:${port}/postgres`;
  process.env.ADMIN_PHONE = '0770000000';
  return pg;
}
module.exports = { startDb };
