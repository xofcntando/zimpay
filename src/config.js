const env = process.env;
const provider = env.PAYMENT_PROVIDER || 'mock';

// Safety gate: real money mode needs an explicit confirmation that a licensed partner is in place.
if (provider !== 'mock' && env.LICENSED_PARTNER_CONFIRMED !== 'yes') {
  throw new Error('Live provider requested but LICENSED_PARTNER_CONFIRMED != "yes". ' +
    'Moving money in Zimbabwe requires an RBZ licence or a licensed partner. Staying in mock mode is the default.');
}

module.exports = {
  isProd: env.NODE_ENV === 'production',
  provider,
  sandbox: provider === 'mock',
  appName: env.APP_NAME || 'ZimPay',
  baseUrl: env.BASE_URL || 'http://localhost:3000',
  adminPhone: env.ADMIN_PHONE || '',
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  mongoUri: env.MONGODB_URI,
  dbName: env.MONGODB_DB || 'zimpay',
  currencies: ['USD', 'ZWG'],
  feeBps: { transfer: Number(env.FEE_TRANSFER_BPS ?? 0), cashout: Number(env.FEE_CASHOUT_BPS ?? 100) },
  // limits in minor units (cents) per currency, by KYC level
  limits: {
    none:     { USD: { single: 5000,    daily: 10000 },   ZWG: { single: 130000,   daily: 260000 } },
    verified: { USD: { single: 200000,  daily: 500000 },  ZWG: { single: 5200000,  daily: 13000000 } },
  },
  smsSecret: env.SMS_WEBHOOK_SECRET || '',
  // top-ups above these amounts (minor units) are never auto-confirmed from SMS; an admin must approve
  autoConfirmMax: { USD: Math.round(Number(env.AUTO_CONFIRM_MAX_USD ?? 50) * 100), ZWG: Math.round(Number(env.AUTO_CONFIRM_MAX_ZWG ?? 1300) * 100) },
  merchantEcocash: env.MERCHANT_ECOCASH_NUMBER || '',
  merchantName: env.MERCHANT_ECOCASH_NAME || '',
  paynow: { id: env.PAYNOW_ID, key: env.PAYNOW_KEY, authEmail: env.PAYNOW_AUTH_EMAIL },
};
