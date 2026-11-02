// Manual EcoCash: the customer sends money to the merchant's own EcoCash number and submits the EcoCash
// reference; an admin checks the merchant wallet and confirms. No third-party API involved.
module.exports = {
  name: 'manual',
  autoPayout: false,
  async initiateCashIn() { return { status: 'pending' }; },
  async checkCashIn() { return { status: 'pending' }; }, // only an admin can confirm
};
