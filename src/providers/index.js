const cfg = require('../config');
const map = { mock: require('./mock'), paynow: require('./paynow') };
if (!map[cfg.provider]) throw new Error('Unknown PAYMENT_PROVIDER ' + cfg.provider);
module.exports = map[cfg.provider];
