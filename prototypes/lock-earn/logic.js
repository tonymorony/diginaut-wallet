// PROTOTYPE — throwaway code. Not production. No tests. No persistence.
//
// QUESTION: can a self-custodial "lock and earn" product for DigiDollar work with
// ZERO DigiByte consensus changes — and where exactly does trust enter?
//
// This is the PURE half: no I/O, no console, no ANSI. `initialState()` +
// `dispatch(state, action) => { state, events }`. Everything the question turns on
// (consensus rejections, the escrow-key trust boundary, sub-$1 carry, freeze
// interaction) lives here so it could be lifted out later.
//
// Byte-real artifacts: nVersion and OP_RETURN envelopes come from the real
// protocol library (packages/digidollar-js). Bond leaf scripts and their taproot
// output keys are built here with the same BIP-341 math taproot.js uses.

import { buildDDVersion, buildTransferMetadata, COLLATERAL_NUMS_KEY } from '../../packages/digidollar-js/src/index.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EPOCH_LEN = 60;              // blocks per epoch
export const REGISTRATION_BLOCKS = 15;    // product rule: locks only in the first 15 blocks
export const FLOOR_BPS = 150;             // 1.5% per epoch, escrowed floor
export const MAX_PAYOUTS_PER_TX = 8;      // product cap under the 83-byte OP_RETURN relay cap
export const MIN_OUTPUT_CENTS = 100;      // consensus: $1 min per DD output (validation.cpp:1756)
export const OP_RETURN_RELAY_CAP_BYTES = 83; // policy.h:74 — no DD exemption
export const PREMIUM_CENTS = 1240;        // one Mint-to-Order issuance premium, $12.40
export const GENESIS_HEIGHT = 1000;

// Fixed FAKE 32-byte staker x-only keys (sha256 of a label). They are never
// lifted to a curve point — they only ride inside the leaf script as bytes —
// so every hex below is byte-real even though the keys are not real keys.
const STAKER_KEYS = {
  alice: 'e2715a8fe8cb26d060a82103ee1ee05a0463902385948f6b582be4f04d1a2605',
  bob: 'c9a595459fc74c71a950a0d50f550c4c9f6d55b726b3b6d894d91d070156934d',
  carol: '4c2d8524610afd8e25c74124b3d2763ef69cb389d7aacce353c2e0116b3112ef',
};

// ---------------------------------------------------------------------------
// Bond script + taproot (BIP-341, replicated from packages/digidollar-js/src/taproot.js)
// ---------------------------------------------------------------------------

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;
const LEAF_VERSION = 0xc0;

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** CScriptNum: minimal signed little-endian, pushed with a direct length byte. */
function pushScriptNum(value) {
  let v = BigInt(value);
  if (v === 0n) return [0x00];
  const out = [];
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return [out.length, ...out];
}

/**
 * The bond's single tapscript leaf:
 *   <unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <stakerXOnlyKey> OP_CHECKSIG
 * Only the staker's key can ever spend it, and only at/after unlockHeight.
 */
export function bondLeafHex({ stakerKeyHex, unlockHeight }) {
  return bytesToHex(Uint8Array.from([
    ...pushScriptNum(unlockHeight),
    0xb1,               // OP_CHECKLOCKTIMEVERIFY
    0x75,               // OP_DROP
    0x20, ...hexToBytes(stakerKeyHex), // push32 <staker x-only key>
    0xac,               // OP_CHECKSIG
  ]));
}

function tapLeafHash(script) {
  return taggedHash('TapLeaf', Uint8Array.from([LEAF_VERSION, script.length, ...script]));
}

/**
 * BIP-341 output key for a SINGLE-leaf tree over the NUMS internal key: the
 * merkle root IS the leaf hash. NUMS internal key ⇒ provably no key-path bypass.
 */
export function bondOutputKey({ stakerKeyHex, unlockHeight }) {
  const root = tapLeafHash(hexToBytes(bondLeafHex({ stakerKeyHex, unlockHeight })));
  const internal = hexToBytes(COLLATERAL_NUMS_KEY);
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', new Uint8Array([...internal, ...root]))));
  if (t >= CURVE_N) throw new RangeError('tap tweak overflow');
  const P = schnorr.utils.lift_x(BigInt('0x' + COLLATERAL_NUMS_KEY));
  const Q = P.add(Point.BASE.multiply(t)).toAffine();
  return Q.x.toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------------------
// Transfer envelopes (byte-real, from the protocol library)
// ---------------------------------------------------------------------------

const TRANSFER_VERSION = buildDDVersion('transfer');

const envelopeBytes = (hex) => hex.length / 2;

/** The real check behind the payout cap: the DD envelope rides the 83-byte relay cap. */
function envelopeFor(amountsCents) {
  const hex = buildTransferMetadata({ amountsCents });
  if (envelopeBytes(hex) > OP_RETURN_RELAY_CAP_BYTES) {
    throw new RangeError(`envelope ${envelopeBytes(hex)}B exceeds ${OP_RETURN_RELAY_CAP_BYTES}B relay cap`);
  }
  return hex;
}

/** Greedy chunking: bounded by the product cap AND by the real 83-byte envelope cap. */
function chunkPayouts(payouts) {
  const chunks = [];
  let current = [];
  for (const p of payouts) {
    const next = [...current, p];
    const fits = next.length <= MAX_PAYOUTS_PER_TX
      && envelopeBytes(buildTransferMetadata({ amountsCents: next.map((x) => x.amountCents) })) <= OP_RETURN_RELAY_CAP_BYTES;
    if (fits) { current = next; continue; }
    chunks.push(current);
    current = [p];
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const clone = (v) => structuredClone(v);

export function initialState() {
  return {
    chain: { height: GENESIS_HEIGHT, frozen: false },
    stakers: [
      { name: 'alice', balanceCents: 25_000, receivedCents: 0 },
      { name: 'bob', balanceCents: 190_000, receivedCents: 0 },
      { name: 'carol', balanceCents: 4_000, receivedCents: 0 },
    ],
    operator: { vanished: false, revenueCents: 0, escrow: null },
    epoch: {
      id: 1,
      startHeight: GENESIS_HEIGHT,
      endHeight: GENESIS_HEIGHT + EPOCH_LEN,
      stakes: [],
      carryCents: { alice: 0, bob: 0, carol: 0 },
    },
    events: [],
  };
}

/** registration | accruing | ended — derived, never stored. */
export function epochPhase(state) {
  const { height } = state.chain;
  const { startHeight, endHeight } = state.epoch;
  if (height >= endHeight) return 'ended';
  if (height < startHeight + REGISTRATION_BLOCKS) return 'registration';
  return 'accruing';
}

export function escrowStatus(state) {
  const e = state.operator.escrow;
  if (!e) return 'none';
  if (e.rugged) return 'RUGGED';
  if (e.chunks.every((c) => c.broadcast)) return 'PAID';
  if (e.keyDeleted) return 'KEY DELETED';
  return 'signed (key live)';
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const findStaker = (s, name) => s.stakers.find((x) => x.name === name);
const findStake = (s, name) => s.epoch.stakes.find((x) => x.staker === name);
const activeStakes = (s) => s.epoch.stakes.filter((x) => x.state === 'active');

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer. Returns a NEW state plus the events this action produced.
 * `state.events` is the cumulative log; the returned `events` is the delta.
 */
export function dispatch(state, action) {
  const next = clone(state);
  const out = [];
  const ok = (text) => out.push({ kind: 'ok', text });
  const reject = (text) => out.push({ kind: 'reject', text });
  const alarm = (text) => out.push({ kind: 'alarm', text });

  const handlers = {
    LOCK: () => lock(next, action.staker, { ok, reject }),
    TICK: () => tick(next, action.blocks ?? 1, { ok }),
    ESCROW: () => escrow(next, { ok, reject }),
    DELETE_KEY: () => deleteKey(next, { reject, alarm }),
    RUG: () => rug(next, { reject, alarm }),
    REVENUE: () => revenue(next, { ok }),
    TOPUP: () => topup(next, { ok, reject }),
    VANISH: () => vanish(next, { ok }),
    EARLY_UNLOCK: () => earlyUnlock(next, { ok, reject }),
    UNLOCK: () => unlock(next, { ok, reject }),
    BROADCAST: () => broadcast(next, { ok, reject }),
    FREEZE: () => freeze(next, { ok, alarm }),
    NEXT_EPOCH: () => nextEpoch(next, { ok, reject }),
  };

  const handler = handlers[action.type];
  if (!handler) reject(`unknown action ${action.type}`);
  else handler();

  next.events = [...next.events, ...out];
  return { state: next, events: out };
}

// --- lock -------------------------------------------------------------------

function lock(s, name, { ok, reject }) {
  const staker = findStaker(s, name);
  if (s.chain.frozen) {
    return reject(`REJECT lock (${name}): DD ops frozen (≥30%/24h all-ops freeze, volatility.h:66) — every DD tx is rejected`);
  }
  if (epochPhase(s) !== 'registration') {
    return reject(`REJECT lock (${name}): epoch ${s.epoch.id} registration closed at height ${s.epoch.startHeight + REGISTRATION_BLOCKS} (product rule, not consensus)`);
  }
  if (findStake(s, name)) {
    return reject(`REJECT lock (${name}): already holds a bond in epoch ${s.epoch.id}`);
  }
  if (staker.balanceCents < MIN_OUTPUT_CENTS) {
    return reject(`REJECT lock (${name}): ${usd(staker.balanceCents)} < $1.00 min DD output (validation.cpp:1756)`);
  }

  const amountCents = staker.balanceCents;
  const unlockHeight = s.epoch.endHeight;
  const stakerKeyHex = STAKER_KEYS[name];
  staker.balanceCents = 0;
  s.epoch.stakes.push({
    staker: name,
    amountCents,
    state: 'pending',
    bond: {
      unlockHeight,
      leafHex: bondLeafHex({ stakerKeyHex, unlockHeight }),
      outputKey: bondOutputKey({ stakerKeyHex, unlockHeight }),
    },
    lockTx: { nVersion: TRANSFER_VERSION, envelopeHex: envelopeFor([amountCents]) },
  });
  ok(`${name} locks ${usd(amountCents)} into a CLTV bond, unlockHeight ${unlockHeight} — self-custodial, NUMS internal key (no key path)`);
  ok(`${name}'s lock tx is PENDING: DD inputs must be CONFIRMED before the stake counts (validation.cpp:1810-1813) — tick a block`);
}

// --- tick -------------------------------------------------------------------

function tick(s, blocks, { ok }) {
  s.chain.height += blocks;
  ok(`+${blocks} block${blocks === 1 ? '' : 's'} → height ${s.chain.height}`);
  const confirming = s.epoch.stakes.filter((x) => x.state === 'pending');
  for (const st of confirming) {
    st.state = 'active';
    ok(`${st.staker}'s lock confirmed → ACTIVE (DD input now spendable by the protocol's rules)`);
  }
}

// --- escrow the floor -------------------------------------------------------

function escrow(s, { ok, reject }) {
  if (s.operator.vanished) return reject('REJECT escrow: operator vanished — nobody is there to fund the floor');
  if (s.operator.escrow) return reject(`REJECT escrow: epoch ${s.epoch.id} floor pool already escrowed (${escrowStatus(s)})`);
  const active = activeStakes(s);
  if (!active.length) return reject('REJECT escrow: no ACTIVE stakes — pending locks are unconfirmed DD and cannot be counted');

  // Share = this epoch's floor accrual + whatever was too small to pay before.
  // Anything still under the $1 min DD output cannot become an output at all.
  const floorCents = active.reduce((sum, st) => sum + Math.floor((st.amountCents * FLOOR_BPS) / 10_000), 0);
  const payouts = [];
  let carriedCents = 0;
  for (const st of active) {
    const floorShare = Math.floor((st.amountCents * FLOOR_BPS) / 10_000);
    const share = floorShare + s.epoch.carryCents[st.staker];
    if (share < MIN_OUTPUT_CENTS) {
      s.epoch.carryCents[st.staker] = share;
      carriedCents += share;
      reject(`CARRY (${st.staker}): floor share ${usd(share)} < $1.00 min DD output (validation.cpp:1756) — no output can exist for it; accrues to the next epoch`);
      continue;
    }
    s.epoch.carryCents[st.staker] = 0;
    payouts.push({ staker: st.staker, amountCents: share });
  }

  // The escrow must cover exactly what the pre-signed txs pay — no more, no less.
  const poolCents = payouts.reduce((a, p) => a + p.amountCents, 0);
  if (poolCents <= 0) {
    return reject(`REJECT escrow: every share is under the $1 min DD output — nothing is escrowable this epoch (${usd(carriedCents)} carried)`);
  }
  if (s.operator.revenueCents < poolCents) {
    return reject(`REJECT escrow: operator revenue ${usd(s.operator.revenueCents)} < payable floor ${usd(poolCents)} — the floor is only real if it is FUNDED first`);
  }
  s.operator.revenueCents -= poolCents;

  const chunks = chunkPayouts(payouts).map((group, i) => ({
    index: i,
    payouts: group,
    envelopeHex: envelopeFor(group.map((p) => p.amountCents)),
    nVersion: TRANSFER_VERSION,
    nLockTime: s.epoch.endHeight,
    broadcast: false,
  }));

  s.operator.escrow = { amountCents: poolCents, keyDeleted: false, rugged: false, chunks };

  ok(`operator escrows ${usd(poolCents)} under an EPHEMERAL key (floor accrual this epoch ${usd(floorCents)}) — the key still exists, so the operator CAN still rug`);
  ok(`pre-signed ${chunks.length} distribution chunk${chunks.length === 1 ? '' : 's'} (${payouts.length} payouts, ${usd(poolCents)}), SIGHASH_ALL|ANYONECANPAY, nLockTime ${s.epoch.endHeight} — any staker can add a fee input and broadcast`);
  if (carriedCents > 0) {
    reject(`${usd(carriedCents)} of carry is NOT escrowed — sub-$1 shares can never be an output, so the carry stays an UNESCROWED PROMISE until an epoch where it clears $1`);
  }
}

// --- the trust boundary -----------------------------------------------------

function deleteKey(s, { reject, alarm }) {
  const e = s.operator.escrow;
  if (!e) return reject('REJECT key-delete: nothing is escrowed yet');
  if (e.rugged) return reject('REJECT key-delete: escrow already rugged — the key was used');
  if (e.keyDeleted) return reject('REJECT key-delete: ephemeral key already deleted');
  e.keyDeleted = true;
  alarm('*** ESCROW KEY DELETED — the floor is now TRUSTLESS. The only signature that can ever spend the escrow UTXO is the pre-signed distribution. ***');
  alarm('*** Residual trust: "did they really delete it" is unprovable (statechain-class). A rug is at least publicly visible on-chain, forever. ***');
}

function rug(s, { reject, alarm }) {
  const e = s.operator.escrow;
  if (!e) return reject('REJECT rug: no escrow exists to double-spend');
  if (e.rugged) return reject('REJECT rug: escrow already rugged');
  if (e.chunks.every((c) => c.broadcast)) {
    return reject('RUG FAILED: the distribution is already broadcast — the escrow UTXO is spent, there is nothing left to double-spend');
  }
  if (e.keyDeleted) {
    return alarm('RUG FAILED: the ephemeral key is deleted. The operator holds NO signature that spends this escrow. ← this is the whole trust boundary.');
  }
  e.rugged = true;
  s.operator.revenueCents += e.amountCents;
  alarm(`*** OPERATOR RUGGED THE ESCROW — double-spent ${usd(e.amountCents)} with the still-live ephemeral key. Every pre-signed chunk now references a spent UTXO. ***`);
  alarm('*** Bonds are UNAFFECTED: they are consensus-enforced CLTV+CHECKSIG under the stakers own keys. Only the reward is gone. ***');
}

// --- revenue and the variable top-up ---------------------------------------

function revenue(s, { ok }) {
  s.operator.revenueCents += PREMIUM_CENTS;
  ok(`DD buyer paid issuance premium (Mint-to-Order) → operator revenue +${usd(PREMIUM_CENTS)} = ${usd(s.operator.revenueCents)}`);
}

function topup(s, { ok, reject }) {
  if (s.operator.vanished) {
    return reject('REJECT top-up: operator vanished. The top-up is a PROMISE, not a pre-signed tx — it simply never happens. The escrowed floor still pays.');
  }
  if (s.chain.frozen) return reject('REJECT top-up: DD ops frozen (≥30%/24h all-ops freeze) — the transfer is rejected');
  if (epochPhase(s) !== 'ended') {
    return reject(`REJECT top-up: epoch ${s.epoch.id} has not ended (height ${s.chain.height} < endHeight ${s.epoch.endHeight})`);
  }
  const stakes = s.epoch.stakes.filter((x) => x.state !== 'pending');
  if (!stakes.length) return reject('REJECT top-up: no stakes in this epoch');
  if (s.operator.revenueCents <= 0) return reject('REJECT top-up: operator revenue is zero — nothing above the floor to share');

  const total = stakes.reduce((a, st) => a + st.amountCents, 0);
  const budget = s.operator.revenueCents;
  const payouts = [];
  for (const st of stakes) {
    const share = Math.floor((budget * st.amountCents) / total) + s.epoch.carryCents[st.staker];
    if (share < MIN_OUTPUT_CENTS) {
      s.epoch.carryCents[st.staker] = share;
      reject(`CARRY (${st.staker}): top-up share ${usd(share)} < $1.00 min DD output (validation.cpp:1756) — carried forward`);
      continue;
    }
    s.epoch.carryCents[st.staker] = 0;
    payouts.push({ staker: st.staker, amountCents: share });
  }
  if (!payouts.length) return reject('REJECT top-up: every share is under the $1 min DD output — nothing is payable on-chain');

  const chunks = chunkPayouts(payouts);
  let paid = 0;
  for (const p of payouts) {
    const staker = findStaker(s, p.staker);
    staker.balanceCents += p.amountCents;
    staker.receivedCents += p.amountCents;
    paid += p.amountCents;
  }
  s.operator.revenueCents -= paid;
  const envelopes = chunks.map((g) => envelopeFor(g.map((p) => p.amountCents)));
  ok(`operator pays variable top-up ${usd(paid)} in ${chunks.length} NORMAL transfer${chunks.length === 1 ? '' : 's'} (not pre-signed, envelope ${envelopes.map(envelopeBytes).join('+')}B ≤ ${OP_RETURN_RELAY_CAP_BYTES}B) — pure promise, honored`);
}

function vanish(s, { ok }) {
  s.operator.vanished = !s.operator.vanished;
  if (s.operator.vanished) {
    ok('operator VANISHED — cannot escrow, cannot top up. Already pre-signed chunks stay broadcastable by any staker.');
  } else {
    ok('operator is back.');
  }
}

// --- bonds ------------------------------------------------------------------

function earlyUnlock(s, { ok, reject }) {
  const immature = s.epoch.stakes.filter((x) => x.state === 'active' && s.chain.height < x.bond.unlockHeight);
  if (!immature.length) {
    const matured = s.epoch.stakes.filter((x) => x.state === 'active');
    if (!matured.length) return reject('REJECT early-unlock probe: no active bonds to try to steal');
    return ok(`early-unlock probe: nothing is early — height ${s.chain.height} ≥ unlockHeight ${matured[0].bond.unlockHeight}. Press u to unlock normally.`);
  }
  for (const st of immature) {
    reject(`REJECT early unlock (${st.staker}): script-path CLTV: height ${s.chain.height} < unlockHeight ${st.bond.unlockHeight}; no key path exists (NUMS internal key ${COLLATERAL_NUMS_KEY.slice(0, 12)}…)`);
  }
}

function unlock(s, { ok, reject }) {
  if (s.chain.frozen) {
    return reject('REJECT unlock: DD ops frozen (≥30%/24h all-ops freeze). The bond spend is itself a DD transfer, so it is rejected too — the staker is locked in past maturity.');
  }
  const matured = s.epoch.stakes.filter((x) => x.state === 'active' && s.chain.height >= x.bond.unlockHeight);
  if (!matured.length) {
    const active = s.epoch.stakes.filter((x) => x.state === 'active');
    if (!active.length) return reject('REJECT unlock: no active bonds');
    return reject(`REJECT unlock: no matured bonds — height ${s.chain.height} < unlockHeight ${active[0].bond.unlockHeight}`);
  }
  for (const st of matured) {
    st.state = 'unlocked';
    findStaker(s, st.staker).balanceCents += st.amountCents;
    ok(`${st.staker} unlocks ${usd(st.amountCents)} — CLTV satisfied (${s.chain.height} ≥ ${st.bond.unlockHeight}), signed by ${st.staker}'s key alone. Zero trust, all epoch long.`);
  }
}

// --- distribution -----------------------------------------------------------

function broadcast(s, { ok, reject }) {
  const e = s.operator.escrow;
  if (!e) return reject('REJECT broadcast: no pre-signed distribution exists');
  if (e.rugged) return reject('REJECT broadcast: the escrow was RUGGED — every pre-signed chunk spends a UTXO that no longer exists');
  if (s.chain.frozen) {
    return reject('REJECT broadcast: DD ops frozen (≥30%/24h all-ops freeze). The tx does NOT expire — nLockTime txs stay valid, so it confirms after unfreeze.');
  }
  const pending = e.chunks.filter((c) => !c.broadcast);
  if (!pending.length) return reject('REJECT broadcast: every chunk is already broadcast');
  const early = pending.filter((c) => s.chain.height < c.nLockTime);
  if (early.length) {
    return reject(`REJECT broadcast: non-final tx — height ${s.chain.height} < nLockTime ${early[0].nLockTime}`);
  }

  let paid = 0;
  for (const c of pending) {
    for (const p of c.payouts) {
      const staker = findStaker(s, p.staker);
      staker.balanceCents += p.amountCents;
      staker.receivedCents += p.amountCents;
      paid += p.amountCents;
    }
    c.broadcast = true;
    ok(`chunk ${c.index + 1}/${e.chunks.length} broadcast by a staker who attached their own fee input (ANYONECANPAY) — ${c.payouts.length} payouts`);
  }
  ok(`floor distribution PAID ${usd(paid)}${s.operator.vanished ? ' — with the operator still vanished. That is the point.' : ''}`);
}

// --- chain conditions -------------------------------------------------------

function freeze(s, { ok, alarm }) {
  s.chain.frozen = !s.chain.frozen;
  if (s.chain.frozen) {
    alarm('*** VOLATILITY FREEZE ON — ≥30%/24h all-ops freeze (volatility.h:66). EVERY DD tx is rejected: locks, unlocks, distributions, top-ups. ***');
    alarm('*** Freeze duration is UNBOUNDED — the 36h cooldown is a floor, not a ceiling (volatility.cpp:314-320). ***');
  } else {
    ok('volatility freeze lifted — DD ops live again. Nothing expired while frozen: nLockTime/CLTV txs never do.');
  }
}

function nextEpoch(s, { ok, reject }) {
  if (epochPhase(s) !== 'ended') {
    return reject(`REJECT next epoch: epoch ${s.epoch.id} has not ended (height ${s.chain.height} < endHeight ${s.epoch.endHeight})`);
  }
  const e = s.operator.escrow;
  if (e && !e.rugged && !e.chunks.every((c) => c.broadcast)) {
    reject(`WARNING: epoch ${s.epoch.id} closes with an un-broadcast distribution. It stays valid forever — but until someone broadcasts, nobody is paid.`);
  }
  const stillLocked = s.epoch.stakes.filter((x) => x.state === 'active');
  for (const st of stillLocked) {
    reject(`WARNING (${st.staker}): bond ${usd(st.amountCents)} still unspent past unlockHeight ${st.bond.unlockHeight}. It is theirs whenever they want it — nobody else can touch it.`);
  }

  const carry = { ...s.epoch.carryCents };
  s.epoch = {
    id: s.epoch.id + 1,
    startHeight: s.chain.height,
    endHeight: s.chain.height + EPOCH_LEN,
    stakes: [],
    carryCents: carry,
  };
  s.operator.escrow = null;
  ok(`epoch ${s.epoch.id} opens at height ${s.epoch.startHeight} — registration closes at ${s.epoch.startHeight + REGISTRATION_BLOCKS}, ends at ${s.epoch.endHeight}`);
  const rolled = Object.entries(carry).filter(([, c]) => c > 0);
  if (rolled.length) {
    ok(`carry rolled forward: ${rolled.map(([n, c]) => `${n} ${usd(c)}`).join(', ')} — these become payable once share + carry ≥ $1.00`);
  }
}
