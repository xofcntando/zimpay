class UserError extends Error {}

function parseAmount(str) {
  const s = String(str || '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new UserError('Enter a valid amount, e.g. 10.50');
  const [w, f = ''] = s.split('.');
  const minor = Number(w) * 100 + Number(f.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new UserError('Amount must be greater than zero');
  return minor;
}

function fmt(minor, cur) {
  const n = Number(minor) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cur === 'USD' ? 'US$' : 'ZiG ') + s;
}

// Accepts 077xxxxxxx, 77xxxxxxx, +26377xxxxxxx, 26377xxxxxxx. Returns +2637xxxxxxxx or throws.
function normPhone(input) {
  let s = String(input || '').replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('263')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);
  if (!/^7\d{8}$/.test(s)) throw new UserError('Enter a valid Zimbabwe mobile number, e.g. 0771234567');
  return '+263' + s;
}

function feeFor(amount, bps) {
  return Math.ceil((amount * bps) / 10000);
}

module.exports = { UserError, parseAmount, fmt, normPhone, feeFor };
