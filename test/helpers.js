const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.ADMIN_PHONE = '0770000000';
async function startDb() {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', args: ['--setParameter', 'indexBuildMinAvailableDiskSpaceMB=10'] },
  });
  process.env.MONGODB_URI = rs.getUri();
  return rs;
}
module.exports = { startDb };
