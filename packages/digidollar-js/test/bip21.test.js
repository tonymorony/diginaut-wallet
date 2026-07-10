import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBip21, parseBip21, satsToDgbString } from 'digidollar-js';

// A real regtest taproot address — the address body is opaque to BIP21; parity
// is about the scheme, amount units and query wire format, not the address type.
const ADDR = 'dgbrt1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zaqqu2v0h';

test('encode: bare address emits just the scheme', () => {
  assert.equal(encodeBip21({ address: ADDR }), `digibyte:${ADDR}`);
});

test('encode: amount is DGB, trailing zeros stripped, no scientific notation', () => {
  assert.equal(encodeBip21({ address: ADDR, amountSats: 150_000_000n }), `digibyte:${ADDR}?amount=1.5`);
  assert.equal(encodeBip21({ address: ADDR, amountSats: 1_000_000_000n }), `digibyte:${ADDR}?amount=10`);
  assert.equal(encodeBip21({ address: ADDR, amountSats: 1n }), `digibyte:${ADDR}?amount=0.00000001`);
  assert.equal(encodeBip21({ address: ADDR, amountSats: 0n }), `digibyte:${ADDR}?amount=0`);
});

test('encode: label and message are url-encoded and ordered amount,label,message', () => {
  assert.equal(
    encodeBip21({ address: ADDR, amountSats: 150_000_000n, label: 'Coffee & Cake', message: 'thanks!' }),
    `digibyte:${ADDR}?amount=1.5&label=Coffee%20%26%20Cake&message=thanks!`,
  );
});

test('encode: throws without an address', () => {
  assert.throws(() => encodeBip21({ amountSats: 1n }), /address is required/);
});

test('parse: bare address passes through unchanged', () => {
  assert.deepEqual(parseBip21(ADDR), { address: ADDR, amountSats: null, label: null, message: null });
  assert.deepEqual(parseBip21(`  ${ADDR}  `), { address: ADDR, amountSats: null, label: null, message: null });
});

test('parse: full URI yields address + amount(sats) + label + message', () => {
  assert.deepEqual(
    parseBip21(`digibyte:${ADDR}?amount=1.5&label=Coffee%20%26%20Cake&message=thanks!`),
    { address: ADDR, amountSats: 150_000_000n, label: 'Coffee & Cake', message: 'thanks!' },
  );
});

test('parse: amount edge cases (8-decimal, Kotlin "10.0", zero, absent)', () => {
  assert.equal(parseBip21(`digibyte:${ADDR}?amount=0.00000001`).amountSats, 1n);
  assert.equal(parseBip21(`digibyte:${ADDR}?amount=10.0`).amountSats, 1_000_000_000n); // Android Double.toString form
  assert.equal(parseBip21(`digibyte:${ADDR}?amount=1.0E-8`).amountSats, 1n); // scientific notation from mobile
  assert.equal(parseBip21(`digibyte:${ADDR}?amount=0`).amountSats, 0n);
  assert.equal(parseBip21(`digibyte:${ADDR}`).amountSats, null);
  assert.equal(parseBip21(`digibyte:${ADDR}?label=x`).amountSats, null);
});

test('parse: non-numeric amount degrades to null, address still returned', () => {
  assert.deepEqual(parseBip21(`digibyte:${ADDR}?amount=abc`), {
    address: ADDR, amountSats: null, label: null, message: null,
  });
});

test('parse: rejects other URI schemes but not bare input', () => {
  assert.equal(parseBip21('digiid://example.com/callback'), null);
  assert.equal(parseBip21('http://evil.example/pay'), null);
  assert.equal(parseBip21(''), null);
  assert.equal(parseBip21('   '), null);
  assert.equal(parseBip21(null), null);
});

test('parse: empty address after scheme is rejected', () => {
  assert.equal(parseBip21('digibyte:'), null);
  assert.equal(parseBip21('digibyte:?amount=1'), null);
});

test('satsToDgbString: exact, grouping-free (safe to feed a plain decimal parser)', () => {
  assert.equal(satsToDgbString(0n), '0');
  assert.equal(satsToDgbString(150_000_000n), '1.5');
  assert.equal(satsToDgbString(1n), '0.00000001');
  // ≥1000 DGB must NOT gain a thousands comma (would break dgbToSats at send review)
  assert.equal(satsToDgbString(100_000_000_000n), '1000');
  assert.equal(satsToDgbString(1_234_567_123_45678n), '1234567.12345678');
  assert.doesNotMatch(satsToDgbString(100_000_000_000n), /,/);
});

test('round-trip: parse(encode(x)) recovers every field', () => {
  for (const x of [
    { address: ADDR, amountSats: null, label: null, message: null },
    { address: ADDR, amountSats: 150_000_000n, label: null, message: null },
    { address: ADDR, amountSats: 1n, label: 'rent', message: null },
    { address: ADDR, amountSats: 99_999_999n, label: 'Coffee & Cake', message: 'see you at 5' },
  ]) {
    assert.deepEqual(parseBip21(encodeBip21(x)), x);
  }
});
