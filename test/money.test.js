const { test } = require('node:test'); const assert = require('node:assert/strict');
const { parseAmount, normPhone, feeFor } = require('../src/money');
test('parseAmount', () => {
  assert.equal(parseAmount('10'), 1000); assert.equal(parseAmount('10.5'), 1050); assert.equal(parseAmount('1,000.05'), 100005);
  for (const bad of ['0', '-1', 'abc', '1.234', '']) assert.throws(() => parseAmount(bad));
});
test('normPhone', () => {
  for (const p of ['0771234567', '771234567', '+263771234567', '263771234567', '077 123 4567']) assert.equal(normPhone(p), '+263771234567');
  assert.throws(() => normPhone('0221234567')); assert.throws(() => normPhone('123'));
});
test('feeFor rounds up', () => { assert.equal(feeFor(1000, 100), 10); assert.equal(feeFor(1050, 100), 11); assert.equal(feeFor(100, 0), 0); });
