// Sandbox provider: no real money moves. Cash-in succeeds instantly unless the phone ends in 0000 (simulated failure).
module.exports = {
  name: 'mock',
  async initiateCashIn({ tx }) {
    const failed = String(tx.msisdn).endsWith('0000');
    return { providerRef: 'MOCK-' + tx.id.slice(0, 8), pollUrl: null, status: failed ? 'failed' : 'paid',
      instructions: null };
  },
  async checkCashIn() { return { status: 'paid' }; },
  autoPayout: true, // sandbox cash-outs complete instantly
  async payout({ tx }) { return { providerRef: 'MOCK-OUT-' + tx.id.slice(0, 8) }; },
};
