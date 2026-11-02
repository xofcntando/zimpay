const cfg = require('../config');
const map = { mock: require('./mock'), paynow: require('./paynow'), manual: require('./manual') };
if (!map[cfg.provider]) throw new Error('Unknown PAYMENT_PROVIDER ' + cfg.provider);
module.exports = map[cfg.provider];
