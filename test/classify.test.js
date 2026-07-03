const assert = require('assert');
const { test } = require('node:test');
const { classify } = require('../src/postmates');

// "Oops, you already applied this promotion" — the code is on the account, so
// it must classify as a win even though the message also contains "oops".
test('classify: "already applied this promotion" is a success', () => {
  const r = classify('promotions\noops, you already applied this promotion\napply', '');
  assert.equal(r.result, 'success');
  assert.equal(r.detail, 'Already applied');
});

test('classify: a plain "oops" error is still a rejection', () => {
  const r = classify('oops, something went wrong', '');
  assert.equal(r.result, 'rejected');
  assert.equal(r.detail, 'Error applying code');
});

test('classify: expired / invalid codes still reject', () => {
  assert.equal(classify('this promo has expired', '').detail, 'Code expired');
  assert.equal(classify('promotion code is not valid', '').detail, 'Code not valid');
});

test('classify: rate limit stops the run', () => {
  assert.equal(classify('too many requests, slow down', '').result, 'ratelimited');
});
