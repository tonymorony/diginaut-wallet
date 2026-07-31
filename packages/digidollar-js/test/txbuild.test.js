// Offline differential tests for transfer tx assembly against a real Core-built
// transfer (test/fixtures/transfer-tx.json, txid 9b3069da…): a $30 send with
// $70 DD change, built by senddigidollar on the regtest stand.
// The owner key comes from the mint fixture's OP_RETURN (the DD input being
// spent is the mint's DD token output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransferOutputs, buildRedeemOutputs, buildTransferMetadata, serializeTx, parseTx, ddTokenOutputKey, buildSignedTransferTx, buildSignedRedeemTx, buildSignedMintTx, LOCK_TIERS, xOnlyPubKey } from 'digidollar-js';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/transfer-tx.json', import.meta.url), 'utf8'),
).result;

const OWNER_KEY_HEX = 'c20a139635a064cbfb7ee7c8f1d4362de68f5d6b02e8cf1f6906f0c0e760c034'; // mint fixture owner
const RECIPIENT_OUTPUT_KEY = fixture.vout[0].scriptPubKey.hex.slice(4); // already-tweaked P2TR key

function coreOutputs() {
  return buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 3_000n }],
    ddChangeCents: 7_000n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 1_436_990_756n,
    dgbChangeScriptHex: fixture.vout[2].scriptPubKey.hex,
  });
}

test('rebuilds all four Core transfer outputs byte-for-byte', () => {
  const outputs = coreOutputs();
  assert.equal(outputs.length, 4);
  for (const [i, out] of outputs.entries()) {
    const expected = fixture.vout[i];
    assert.equal(out.valueSats, BigInt(Math.round(expected.value * 1e8)), `vout[${i}] value`);
    assert.equal(
      [...out.script].map((b) => b.toString(16).padStart(2, '0')).join(''),
      expected.scriptPubKey.hex,
      `vout[${i}] script`,
    );
  }
});

test('DD change output key is the tweaked owner key (same as the mint DD token output)', () => {
  // Core reuses CreateDigiDollarP2TR's key-path-only tweak for DD change.
  assert.equal(ddTokenOutputKey(OWNER_KEY_HEX), fixture.vout[1].scriptPubKey.hex.slice(4));
});

test('reserializes the entire Core transfer byte-for-byte (fixture witnesses substituted)', () => {
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const hex = serializeTx({
    version: fixture.version,
    locktime: fixture.locktime,
    inputs: fixture.vin.map((v) => ({ txidHex: v.txid, vout: v.vout, sequence: v.sequence })),
    outputs: coreOutputs(),
    witnesses: fixture.vin.map((v) => v.txinwitness.map(hexToBytes)),
  });
  assert.equal(hex, fixture.hex);
});

// ---- Redeem (test/fixtures/redeem-tx.json, txid b834557b…) ----
// Core redemption of the 1hour-tier mint 4f30aa8f… ($100, lockHeight 1064):
// exact burn — no DD change, no OP_RETURN; collateral returned in full.

const redeemFixture = JSON.parse(
  await readFile(new URL('./fixtures/redeem-tx.json', import.meta.url), 'utf8'),
).result;

function coreRedeemOutputs() {
  return buildRedeemOutputs({
    collateralReturnSats: 7_526_080_476_901n,
    collateralReturnScriptHex: redeemFixture.vout[0].scriptPubKey.hex,
    dgbChangeSats: 1_421_555_756n,
    dgbChangeScriptHex: redeemFixture.vout[1].scriptPubKey.hex,
  });
}

test('rebuilds both Core redeem outputs byte-for-byte (exact burn: no OP_RETURN)', () => {
  const outputs = coreRedeemOutputs();
  assert.equal(outputs.length, 2);
  for (const [i, out] of outputs.entries()) {
    const expected = redeemFixture.vout[i];
    assert.equal(out.valueSats, BigInt(Math.round(expected.value * 1e8)), `vout[${i}] value`);
    assert.equal(
      [...out.script].map((b) => b.toString(16).padStart(2, '0')).join(''),
      expected.scriptPubKey.hex,
      `vout[${i}] script`,
    );
  }
});

test('redeem with DD change appends a DD change P2TR and a type-3 OP_RETURN', () => {
  // Layout per Core BuildRedemptionTransaction: collateral return, DD change,
  // OP_RETURN "DD" <3> <change>, then DGB change. Amounts mirror the (fixture-
  // proven) transfer CScriptNum encoding.
  const outputs = buildRedeemOutputs({
    collateralReturnSats: 100n,
    collateralReturnScriptHex: redeemFixture.vout[0].scriptPubKey.hex,
    ddChangeCents: 3_000n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 50n,
    dgbChangeScriptHex: redeemFixture.vout[1].scriptPubKey.hex,
  });
  assert.equal(outputs.length, 4);
  const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(toHex(outputs[1].script), '5120' + ddTokenOutputKey(OWNER_KEY_HEX));
  assert.equal(toHex(outputs[2].script), '6a024444010302b80b');
  assert.equal(outputs[3].valueSats, 50n);
});

test('reserializes the entire Core redeem byte-for-byte (fixture witnesses substituted)', () => {
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const hex = serializeTx({
    version: redeemFixture.version,
    locktime: redeemFixture.locktime,
    inputs: redeemFixture.vin.map((v) => ({ txidHex: v.txid, vout: v.vout, sequence: v.sequence })),
    outputs: coreRedeemOutputs(),
    witnesses: redeemFixture.vin.map((v) => v.txinwitness.map(hexToBytes)),
  });
  assert.equal(hex, redeemFixture.hex);
});

// ---- dust DGB change is folded into the fee (all three DD builders) ----
// The plain-spend builder has folded change below CHANGE_FOLD_SATS since #6.
// The DigiDollar builders did not, so a fee coin worth a hair more than the fee
// produced a dust DGB change output — and the node rejects the whole
// transaction, which means the DigiDollar cannot move at all.
const FOLD_SATS = 100_000n;      // CHANGE_FOLD_SATS, restated so the test is independent
const TEST_KEY = '11'.repeat(32);
const MARKED_CHANGE_SCRIPT = '0014' + 'cd'.repeat(20); // recognisable in the serialized tx

/** Number of outputs in a serialized segwit tx whose inputs all have empty scriptSig. */
function voutCount(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4; // version
  assert.deepEqual([...b.subarray(o, o + 2)], [0x00, 0x01], 'segwit marker+flag');
  o += 2;
  const varint = () => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    assert.equal(v, 0xfd, 'compact varint only');
    const n = b.readUInt16LE(o + 1); o += 3; return n;
  };
  const nIn = varint();
  o += nIn * 41; // txid(32) + vout(4) + scriptSig len 0x00(1) + sequence(4)
  return varint();
}

test('transfer folds dust DGB change into the fee instead of emitting it', () => {
  const feeSats = 12_000_000n;
  const args = {
    ddUtxo: { txidHex: 'ab'.repeat(32), vout: 1, ddCents: 10_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: ddTokenOutputKey(OWNER_KEY_HEX), cents: 10_000n }],
    feeSats,
    dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
  };
  // 1 sat under the fold threshold: dust, must not become an output
  const dust = buildSignedTransferTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.dgbChangeSats, 0n);
  assert.ok(!dust.hex.includes(MARKED_CHANGE_SCRIPT), 'dust change output must be absent');
  assert.equal(voutCount(dust.hex), 2); // recipient DD + OP_RETURN

  // exactly at the threshold: still worth an output, nothing changes
  const kept = buildSignedTransferTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS },
  });
  assert.equal(kept.dgbChangeSats, FOLD_SATS);
  assert.ok(kept.hex.includes(MARKED_CHANGE_SCRIPT));
  assert.equal(voutCount(kept.hex), 3);
});

test('redeem folds dust DGB change into the fee, leaving the collateral return as the DGB output', () => {
  const feeSats = 16_000_000n;
  const args = {
    collateralUtxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 500_000_000n, lockHeight: 200, ddCents: 10_000n },
    ddUtxos: [{ txidHex: 'ef'.repeat(32), vout: 1, ddCents: 10_000n }],
    privKeyHex: TEST_KEY,
    feeSats,
    dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
  };
  const dust = buildSignedRedeemTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.dgbChangeSats, 0n);
  assert.ok(!dust.hex.includes(MARKED_CHANGE_SCRIPT));
  // Only the collateral return is left — and that is what satisfies Core's
  // "bad-redeem-no-dgb-output" check (digidollar/validation.cpp:2154), which
  // wants any output with nValue > 0, not the change specifically.
  assert.equal(voutCount(dust.hex), 1);

  const kept = buildSignedRedeemTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS },
  });
  assert.equal(kept.dgbChangeSats, FOLD_SATS);
  assert.equal(voutCount(kept.hex), 2);
});

test('mint folds dust change into the fee rather than emitting a dust (or zero-value) output', () => {
  const feeSats = 12_000_000n;
  const base = {
    privKeyHex: TEST_KEY,
    ddCents: 10_000n,
    tierId: LOCK_TIERS[0].id,
    oraclePriceMicroUsd: 13_400n,
    tipHeight: 1_000,
    feeSats,
  };
  const probe = buildSignedMintTx({ ...base, utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n } });
  const collateralSats = probe.collateralSats;

  const dust = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.changeSats, 0n);
  assert.equal(voutCount(dust.hex), 3); // collateral + DD token + OP_RETURN

  // Exact funding used to emit a ZERO-value P2WPKH output, non-standard on its own.
  const exact = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats },
  });
  assert.equal(exact.changeSats, 0n);
  assert.equal(voutCount(exact.hex), 3);

  const kept = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats + FOLD_SATS },
  });
  assert.equal(kept.changeSats, FOLD_SATS);
  assert.equal(voutCount(kept.hex), 4);
});

// ---- every DD output of a transfer is checked against the $1 minimum ----
// Consensus checks all of them, change included: the loop at
// digidollar/validation.cpp:1743 rejects with "transfer-dd-amount-below-minimum".
// Only the recipient was ever validated (app.js), so spending $10.00 out of a
// $10.50 coin built a transfer with 50c of change that the network refuses.
test('transfer refuses to build sub-$1 DD change', () => {
  const build = (ddChangeCents) => buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 3_000n }],
    ddChangeCents,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 1_436_990_756n,
    dgbChangeScriptHex: fixture.vout[2].scriptPubKey.hex,
  });
  assert.throws(() => build(99n), /\$1\.00/);      // 1 cent under: rejected
  assert.equal(build(100n).length, 4);             // exactly $1.00: legal
  assert.equal(build(0n).length, 3);               // no change output at all
});

test('transfer refuses a sub-$1 RECIPIENT too, not just change', () => {
  // Wider than the reported finding, and correct: consensus does not
  // distinguish. No in-repo caller sends sub-$1, but buildTransferOutputs is
  // publicly re-exported, so an embedder gets the same guard.
  assert.throws(() => buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 50n }],
    ddChangeCents: 0n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
  }), /\$1\.00/);
});

test('redeem still builds sub-$1 DD change — Core accepts it, and refusing would strand the position', () => {
  // The redemption scan (validation.cpp:2107-2149) enforces only "at most one
  // DD change output" plus a serialization bound; it never calls
  // ValidateOutputAmount. Full redemption is all-or-nothing, so a builder that
  // refused here would leave a user with no way to free their collateral.
  const outputs = buildRedeemOutputs({
    collateralReturnSats: 500_000_000n,
    collateralReturnScriptHex: '5120' + ddTokenOutputKey(OWNER_KEY_HEX),
    ddChangeCents: 50n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
  });
  assert.equal(outputs.length, 3); // collateral + DD change P2TR + OP_RETURN
});

// ---- parseTx: the inverse of serializeTx (#148) ----
// The library had no transaction parser at all before this. Two callers need
// one: every builder's post-build gate re-parses its OWN bytes, and the
// staker-side chunk verifier parses bytes it RECEIVED from someone else.
// Both layouts are accepted — segwit (BIP-144 marker+flag) and legacy.

const h2b = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

/** Re-serialize a parsed tx; must reproduce the exact bytes it came from. */
function reserialize(tx) {
  return serializeTx({
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => ({ valueSats: o.valueSats, script: h2b(o.scriptHex) })),
    witnesses: tx.witnesses.map((w) => w.map(h2b)),
  });
}

test('parseTx round-trips every shape this library builds', () => {
  const key = '11'.repeat(32);
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  const built = [
    buildSignedMintTx({
      utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n },
      privKeyHex: key, ddCents: 10_000n, tierId: LOCK_TIERS[0].id,
      oraclePriceMicroUsd: 13_400n, tipHeight: 1_000,
    }).hex,
    buildSignedTransferTx({
      ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n },
      feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
      privKeyHex: key, recipients: [{ outputKeyHex: recipient, cents: 2_000n }],
    }).hex,
    buildSignedRedeemTx({
      collateralUtxo: { txidHex: 'cc'.repeat(32), vout: 0, valueSats: 500_000_000n, lockHeight: 1_000, ddCents: 5_000n },
      ddUtxos: [{ txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n }],
      feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
      privKeyHex: key,
    }).hex,
  ];
  for (const hex of built) {
    const tx = parseTx(hex);
    assert.equal(reserialize(tx), hex);
    for (const i of tx.inputs) assert.equal(i.scriptSigHex, ''); // segwit: always empty
  }

  // Field-level round-trip on the transfer: what went in comes back out.
  const tx = parseTx(built[1]);
  assert.equal(tx.locktime, 0);
  assert.deepEqual(tx.inputs.map((i) => [i.txidHex, i.vout, i.sequence]), [
    ['aa'.repeat(32), 1, 0xffffffff],
    ['bb'.repeat(32), 0, 0xffffffff],
  ]);
  assert.equal(tx.outputs[0].scriptHex, `5120${recipient}`);
  assert.equal(tx.outputs[0].valueSats, 0n);
  assert.equal(tx.witnesses.length, 2);
  assert.equal(tx.witnesses[0][0].length, 128); // 64-byte Schnorr signature
});

test('parseTx reproduces the node-decoded fields of all three Core fixtures', async () => {
  for (const name of ['transfer-tx.json', 'redeem-tx.json', 'spend-tx.json']) {
    const f = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).result;
    const tx = parseTx(f.hex);
    assert.equal(tx.version, f.version, `${name} version`);
    assert.equal(tx.locktime, f.locktime, `${name} locktime`);
    assert.deepEqual(
      tx.inputs.map((i) => ({ txid: i.txidHex, vout: i.vout, sequence: i.sequence, scriptSig: i.scriptSigHex })),
      f.vin.map((v) => ({ txid: v.txid, vout: v.vout, sequence: v.sequence, scriptSig: v.scriptSig.hex })),
      `${name} inputs`,
    );
    assert.deepEqual(
      tx.outputs.map((o) => ({ sats: o.valueSats, script: o.scriptHex })),
      f.vout.map((v) => ({ sats: BigInt(Math.round(v.value * 1e8)), script: v.scriptPubKey.hex })),
      `${name} outputs`,
    );
    assert.deepEqual(tx.witnesses, f.vin.map((v) => v.txinwitness), `${name} witnesses`);
    assert.equal(reserialize(tx), f.hex, `${name} re-serializes byte-for-byte`);
  }
});

test('parseTx reads the legacy (no marker) layout of the BIP-341 vector transaction', async () => {
  // DigiByte Core's bip341_wallet_vectors.json ships rawUnsignedTx in the LEGACY
  // serialization — no 00 01 marker, no witness section. A parser that assumed
  // segwit would read the input count as a marker byte.
  const vectors = JSON.parse(
    await readFile(new URL('./fixtures/bip341-wallet-vectors.json', import.meta.url), 'utf8'),
  );
  const tx = parseTx(vectors.keyPathSpending[0].given.rawUnsignedTx);
  assert.equal(tx.version, 2);
  assert.equal(tx.inputs.length, 9);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.locktime, 500_000_000);
  assert.deepEqual(tx.witnesses, Array.from({ length: 9 }, () => []));
  assert.equal(tx.inputs[3].sequence, 0xfffffffe);
});

test('parseTx exposes a non-empty scriptSig instead of refusing the transaction', () => {
  // Our own shapes always have an empty scriptSig, but a verifier of RECEIVED
  // bytes that threw on a foreign scriptSig would be useless.
  const legacy = [
    '02000000', '01',
    'ab'.repeat(32), '00000000',
    '02', '51', '52',              // scriptSig: OP_1 OP_2
    'ffffffff',
    '01', '0000000000000000', '02', '6a51',
    '00000000',
  ].join('');
  const tx = parseTx(legacy);
  assert.equal(tx.inputs[0].scriptSigHex, '5152');
  assert.deepEqual(tx.witnesses, [[]]);
});

test('parseTx refuses truncation, trailing bytes and an unknown segwit flag', () => {
  const good = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
    privKeyHex: '11'.repeat(32),
    recipients: [{ outputKeyHex: ddTokenOutputKey(xOnlyPubKey('22'.repeat(32))), cents: 2_000n }],
  }).hex;
  assert.throws(() => parseTx(good + 'ff'), /trailing/);
  assert.throws(() => parseTx(good.slice(0, -8)), /truncat|ran out/i);
  assert.throws(() => parseTx(good.slice(0, 10) + '02' + good.slice(12)), /flag/); // marker 00, flag 02
  assert.throws(() => parseTx('abc'), /hex/);
});

// ---- taprootSighash hash types (#148) ----
// Ground truth: test/fixtures/bip341-wallet-vectors.json, a verbatim copy of
// DigiByte Core v9.26.4 src/test/data/bip341_wallet_vectors.json. The digests
// there come from BIP-341 itself, so they check this implementation against the
// specification rather than against itself. taprootSighash is imported from the
// module, not the package: it is not part of the public surface (the audited
// builders are the only sanctioned callers) but the suite has to reach it.

const b2h = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

test('taprootSighash reproduces the upstream BIP-341 digests for 0x00, 0x01 and 0x81', async () => {
  const { taprootSighash } = await import('../src/txbuild.js');
  const vectors = JSON.parse(
    await readFile(new URL('./fixtures/bip341-wallet-vectors.json', import.meta.url), 'utf8'),
  );
  const kp = vectors.keyPathSpending[0];
  const tx = parseTx(kp.given.rawUnsignedTx);
  const inputs = tx.inputs.map((i, n) => ({
    txidHex: i.txidHex,
    vout: i.vout,
    sequence: i.sequence,
    valueSats: BigInt(kp.given.utxosSpent[n].amountSats),
    scriptPubKeyHex: kp.given.utxosSpent[n].scriptPubKey,
  }));
  const outputs = tx.outputs.map((o) => ({ valueSats: o.valueSats, script: h2b(o.scriptHex) }));

  let checked = 0;
  let refused = 0;
  for (const s of kp.inputSpending) {
    const args = {
      version: tx.version, locktime: tx.locktime, inputs, outputs,
      inputIndex: s.given.txinIndex, hashType: s.given.hashType,
    };
    if ([0x00, 0x01, 0x81].includes(s.given.hashType)) {
      assert.equal(b2h(taprootSighash(args)), s.intermediary.sigHash, `hashType ${s.given.hashType}`);
      checked += 1;
    } else {
      // SIGHASH_NONE (2), SINGLE (3) and their ANYONECANPAY forms: refused.
      assert.throws(() => taprootSighash(args), /hash type/, `hashType ${s.given.hashType}`);
      refused += 1;
    }
  }
  assert.equal(checked, 3); // DEFAULT (txin 4), ALL (txin 3), ALL|ANYONECANPAY (txin 8)
  assert.equal(refused, 4);
});

test('taprootSighash names SIGHASH_SINGLE and SIGHASH_NONE as deliberate refusals', async () => {
  const { taprootSighash } = await import('../src/txbuild.js');
  const args = {
    version: 2, locktime: 0,
    inputs: [{ txidHex: 'ab'.repeat(32), vout: 0, valueSats: 1_000n, scriptPubKeyHex: `5120${'11'.repeat(32)}`, sequence: 0xffffffff }],
    outputs: [{ valueSats: 900n, script: h2b(`5120${'22'.repeat(32)}`) }],
    inputIndex: 0,
  };
  assert.throws(() => taprootSighash({ ...args, hashType: 0x03 }), /SIGHASH_SINGLE/);
  assert.throws(() => taprootSighash({ ...args, hashType: 0x83 }), /SIGHASH_SINGLE/);
  assert.throws(() => taprootSighash({ ...args, hashType: 0x02 }), /SIGHASH_NONE/);
  assert.throws(() => taprootSighash({ ...args, hashType: 0x82 }), /SIGHASH_NONE/);
  assert.throws(() => taprootSighash({ ...args, hashType: 0x41 }), /hash type/);
});

test('SIGHASH_ANYONECANPAY changes the digest, and the other inputs stop mattering', async () => {
  const { taprootSighash } = await import('../src/txbuild.js');
  const inputs = [
    { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 0n, scriptPubKeyHex: `5120${'11'.repeat(32)}`, sequence: 0xfffffffe },
    { txidHex: 'cd'.repeat(32), vout: 3, valueSats: 5_000n, scriptPubKeyHex: `5120${'33'.repeat(32)}`, sequence: 0xffffffff },
  ];
  const outputs = [{ valueSats: 0n, script: h2b(`5120${'22'.repeat(32)}`) }];
  const base = { version: 2, locktime: 7, inputs, outputs, inputIndex: 0 };
  const acp = b2h(taprootSighash({ ...base, hashType: 0x81 }));
  assert.notEqual(acp, b2h(taprootSighash({ ...base, hashType: 0x01 })));
  // The whole point of ANYONECANPAY: a signature stays valid while other inputs
  // are added or changed — which is what lets any staker attach their own fee.
  const otherInput = [inputs[0], { ...inputs[1], txidHex: 'ef'.repeat(32), valueSats: 9_999n }];
  assert.equal(b2h(taprootSighash({ ...base, inputs: otherInput, hashType: 0x81 })), acp);
  assert.equal(b2h(taprootSighash({ ...base, inputs: [inputs[0]], hashType: 0x81 })), acp);
  // …but the outputs are still committed.
  assert.notEqual(
    b2h(taprootSighash({ ...base, outputs: [{ valueSats: 1n, script: outputs[0].script }], hashType: 0x81 })),
    acp,
  );
});

// ---- the post-build gate core (#148) ----
// checkBuiltDDTx re-derives a transaction's DigiDollar meaning from its FINAL
// SERIALIZED BYTES and compares it to what the builder was asked for. Every
// buildSigned* in the DD family runs it and throws on any failed check, so a
// serialization or envelope bug cannot ship a signature. Here it is driven
// directly, including with doctored bytes no builder would produce.

test('the gate core reports a named check per property and passes a real transfer', async () => {
  const { checkBuiltDDTx } = await import('../src/txbuild.js');
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  const { hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: recipient, cents: 2_000n }],
    dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
  });
  const expect = {
    type: 'transfer',
    ddInCents: 5_000n,
    ddOutputs: [
      { outputKeyHex: recipient, cents: 2_000n },
      { outputKeyHex: ddTokenOutputKey(xOnlyPubKey(TEST_KEY)), cents: 3_000n },
    ],
    valuedOutputs: [{ scriptHex: MARKED_CHANGE_SCRIPT, valueSats: 100_000_000n - 12_000_000n }],
  };
  const result = checkBuiltDDTx({ txHex: hex, expect });
  assert.ok(result.ok, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.deepEqual(result.checks.map((c) => c.name), [
    'parse', 'scriptsig-empty', 'dd-marker', 'output-shapes', 'envelope-present',
    'envelope-pairing', 'envelope-exact', 'envelope-size', 'dd-minimum', 'dd-maximum',
    'dd-conservation', 'dd-outputs-match', 'valued-outputs-match',
  ]);
  // nLockTime and the per-input sequences are checked only when the caller
  // states them — every builder does, and they are what a hand-edited
  // nLockTime or a finalized sequence has to get past.
  const withTiming = checkBuiltDDTx({ txHex: hex, expect: { ...expect, locktime: 0, sequences: [0xffffffff, 0xffffffff] } });
  assert.ok(withTiming.ok);
  assert.deepEqual(withTiming.checks.slice(-2).map((c) => c.name), ['locktime', 'input-sequences']);
});

test('the gate catches an edited nLockTime and an edited sequence', async () => {
  const { checkBuiltDDTx } = await import('../src/txbuild.js');
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  const { hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 2_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 12_000_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: recipient, cents: 2_000n }],
  });
  const expect = {
    type: 'transfer', ddInCents: 2_000n,
    ddOutputs: [{ outputKeyHex: recipient, cents: 2_000n }],
    locktime: 0, sequences: [0xffffffff, 0xffffffff],
  };
  const failed = (e) => checkBuiltDDTx({ txHex: hex, expect: e }).checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed(expect), []);
  assert.deepEqual(failed({ ...expect, locktime: 1 }), ['locktime']);
  assert.deepEqual(failed({ ...expect, sequences: [0xfffffffe, 0xffffffff] }), ['input-sequences']);
  assert.deepEqual(failed({ ...expect, sequences: [0xffffffff] }), ['input-sequences']);
});

// ---- the $100,000 per-output maximum (validation.cpp:1761) ----

test('a DD output above $100,000 is refused early and named by the gate', async () => {
  const { checkBuiltDDTx, MAX_DD_OUTPUT_CENTS } = await import('../src/txbuild.js');
  assert.equal(MAX_DD_OUTPUT_CENTS, 10_000_000n);
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  // Early refusal, where the $1 minimum is already checked.
  assert.throws(() => buildTransferOutputs({
    recipients: [{ outputKeyHex: recipient, cents: MAX_DD_OUTPUT_CENTS + 1n }],
  }), /\$100,000\.00/);
  assert.equal(buildTransferOutputs({ recipients: [{ outputKeyHex: recipient, cents: MAX_DD_OUTPUT_CENTS }] }).length, 2);

  // And named by the gate, which is what sees bytes built elsewhere.
  const over = MAX_DD_OUTPUT_CENTS + 1n;
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const txHex = serializeTx({
    version: 0x02000770,
    locktime: 0,
    inputs: [{ txidHex: 'aa'.repeat(32), vout: 0, sequence: 0xffffffff }],
    outputs: [
      { valueSats: 0n, script: hexToBytes(`5120${recipient}`) },
      { valueSats: 0n, script: hexToBytes(buildTransferMetadata({ amountsCents: [over] })) },
    ],
    witnesses: [[]],
  });
  const result = checkBuiltDDTx({
    txHex,
    expect: { type: 'transfer', ddInCents: over, ddOutputs: [{ outputKeyHex: recipient, cents: over }] },
  });
  assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['dd-maximum']);
});

test('redeem change is exempt from BOTH amount bounds, like the existing carve-out', () => {
  // Core's redemption scan (validation.cpp:2107-2149) amount-checks neither
  // bound, and refusing here would strand a position — the same reasoning that
  // already exempts sub-$1 redeem change.
  const outputs = buildRedeemOutputs({
    collateralReturnSats: 500_000_000n,
    collateralReturnScriptHex: '5120' + ddTokenOutputKey(OWNER_KEY_HEX),
    ddChangeCents: 20_000_000n, // $200,000 — over the transfer maximum
    changeOwnerKeyHex: OWNER_KEY_HEX,
  });
  assert.equal(outputs.length, 3);
});

test('a sub-$1 mint is refused: Core amount-validates mint outputs against the same $1 floor', () => {
  // DD_TX_LIMITS.regtest.minMintCents is 1c, which suggests a 1c mint is legal
  // on regtest. It is not: mint-amount validation passes, then OUTPUT validation
  // (validation.cpp:1092/1135, digidollar.h:73 minOutputAmount = 100, no regtest
  // override) rejects it. The gate refuses before a signature exists.
  assert.throws(() => buildSignedMintTx({
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n },
    privKeyHex: TEST_KEY, ddCents: 50n, tierId: LOCK_TIERS[0].id,
    oraclePriceMicroUsd: 13_400n, tipHeight: 1_000,
  }), /dd-minimum/);
});

// ---- non-canonical CompactSize (Core ReadCompactSize) ----

test('parseTx refuses non-canonical CompactSize encodings', () => {
  // Core's ReadCompactSize throws "non-canonical ReadCompactSize()" when a value
  // is encoded in more bytes than it needs. A parser that accepts them lets two
  // different byte strings claim to be the same transaction.
  const tail = ['ab'.repeat(32), '00000000', '00', 'ffffffff', '01', '0000000000000000', '02', '6a51', '00000000'];
  assert.ok(parseTx(['02000000', '01', ...tail].join('')));                 // canonical
  assert.throws(() => parseTx(['02000000', 'fd0100', ...tail].join('')), /non-canonical/);
  assert.throws(() => parseTx(['02000000', 'fe01000000', ...tail].join('')), /non-canonical/);
  assert.throws(() => parseTx(['02000000', 'ff0100000000000000', ...tail].join('')), /non-canonical/);
  // A genuinely large value in the 0xfd form stays legal.
  assert.throws(() => parseTx(['02000000', 'fdfd00', ...tail].join('')), /truncat|ran out/i);
});

// ---- scriptSig must be empty on every DigiDollar shape ----

test('the gate names an injected scriptSig, which no signature commits to', async () => {
  const { checkBuiltDDTx } = await import('../src/txbuild.js');
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  const { hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 2_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 12_000_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: recipient, cents: 2_000n }],
  });
  // scriptSig length byte of input 0: version(4) + marker/flag(2) + count(1)
  // + txid(32) + vout(4) = byte 43.
  assert.equal(hex.slice(86, 88), '00', 'input 0 scriptSig is empty as built');
  const injected = `${hex.slice(0, 86)}0151${hex.slice(88)}`;
  const expect = {
    type: 'transfer', ddInCents: 2_000n,
    ddOutputs: [{ outputKeyHex: recipient, cents: 2_000n }],
  };
  assert.equal(parseTx(injected).inputs[0].scriptSigHex, '51');
  assert.deepEqual(
    checkBuiltDDTx({ txHex: injected, expect }).checks.filter((c) => !c.ok).map((c) => c.name),
    ['scriptsig-empty'],
  );
});

test('the gate core fails a named check for doctored bytes instead of throwing', async () => {
  const { checkBuiltDDTx } = await import('../src/txbuild.js');
  const recipient = ddTokenOutputKey(xOnlyPubKey('22'.repeat(32)));
  const expect = { type: 'transfer', ddInCents: 2_000n, ddOutputs: [{ outputKeyHex: recipient, cents: 2_000n }] };
  const { hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 2_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 12_000_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: recipient, cents: 2_000n }],
  });
  assert.ok(checkBuiltDDTx({ txHex: hex, expect }).ok);

  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
  // Unparseable bytes: a named parse failure, never an exception.
  const broken = checkBuiltDDTx({ txHex: 'not hex at all', expect });
  assert.equal(broken.ok, false);
  assert.deepEqual(failed(broken), ['parse']);
  // The DD marker stripped out of nVersion (a burn: outputs look like a plain
  // spend to consensus, and the DigiDollar simply ceases to exist).
  const stripped = '02000000' + hex.slice(8);
  assert.deepEqual(failed(checkBuiltDDTx({ txHex: stripped, expect })), ['dd-marker']);
  // Right bytes, wrong intent: the caller expected a different amount.
  assert.deepEqual(
    failed(checkBuiltDDTx({ txHex: hex, expect: { ...expect, ddInCents: 1_900n } })),
    ['dd-conservation'],
  );
  assert.deepEqual(
    failed(checkBuiltDDTx({ txHex: hex, expect: { ...expect, ddOutputs: [{ outputKeyHex: 'ff'.repeat(32), cents: 2_000n }] } })),
    ['dd-outputs-match'],
  );
});
