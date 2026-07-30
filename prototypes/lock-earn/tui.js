// PROTOTYPE — throwaway code. Thin terminal shell over logic.js.
// All business logic lives in logic.js; this file only reads keys and paints frames.
// Works interactively (raw TTY, clears the screen) and piped (renders frames in
// sequence, no clearing, exits at EOF) — the piped path is how it gets smoke-tested.

import {
  initialState, dispatch, epochPhase, escrowStatus,
  EPOCH_LEN, REGISTRATION_BLOCKS, FLOOR_BPS, MAX_PAYOUTS_PER_TX,
  MIN_OUTPUT_CENTS, OP_RETURN_RELAY_CAP_BYTES,
} from './logic.js';

const B = (s) => `\x1b[1m${s}\x1b[0m`;   // bold
const D = (s) => `\x1b[2m${s}\x1b[0m`;   // dim
const R = (s) => `\x1b[1;31m${s}\x1b[0m`; // alarm
const Y = (s) => `\x1b[33m${s}\x1b[0m`;   // reject

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const KEYMAP = {
  1: { type: 'LOCK', staker: 'alice' },
  2: { type: 'LOCK', staker: 'bob' },
  3: { type: 'LOCK', staker: 'carol' },
  t: { type: 'TICK', blocks: 1 },
  T: { type: 'TICK', blocks: 10 },
  e: { type: 'ESCROW' },
  k: { type: 'DELETE_KEY' },
  g: { type: 'RUG' },
  r: { type: 'REVENUE' },
  p: { type: 'TOPUP' },
  v: { type: 'VANISH' },
  x: { type: 'EARLY_UNLOCK' },
  u: { type: 'UNLOCK' },
  b: { type: 'BROADCAST' },
  f: { type: 'FREEZE' },
  n: { type: 'NEXT_EPOCH' },
};

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function frame(state, lastKey) {
  const L = [];
  const { chain, operator, epoch, stakers } = state;

  L.push(B('DD Lock & Earn') + D('  — throwaway logic prototype: can this work with ZERO consensus changes?'));
  L.push(D('Bond: consensus-enforced · Floor: trustless only after key-delete · Top-up: promise'));
  L.push('');

  // chain
  const phase = epochPhase(state);
  const toEnd = epoch.endHeight - chain.height;
  L.push(
    `${B('CHAIN')}  height ${B(chain.height)}  ` +
    `DD ops ${chain.frozen ? R('FROZEN (≥30%/24h all-ops freeze)') : 'live'}  ` +
    `epoch ${B(epoch.id)} · ${phase} · ` +
    D(toEnd > 0 ? `${toEnd} blocks to end (${epoch.endHeight})` : `ended at ${epoch.endHeight}`),
  );

  // operator
  const status = escrowStatus(state);
  const statusText = status === 'RUGGED' ? R(status)
    : status === 'KEY DELETED' ? B(status)
      : status;
  L.push('');
  L.push(
    `${B('OPERATOR')}  ${operator.vanished ? R('VANISHED') : 'present'}  ` +
    `revenue ${B(usd(operator.revenueCents))}  escrow ${statusText}` +
    (operator.escrow ? D(`  (${usd(operator.escrow.amountCents)} pool)`) : ''),
  );
  if (operator.escrow) {
    for (const c of operator.escrow.chunks) {
      const envB = c.envelopeHex.length / 2;
      L.push(
        `  ${D(`chunk ${c.index + 1}/${operator.escrow.chunks.length}`)} ` +
        `${c.payouts.length} payouts  ${D(`nLockTime ${c.nLockTime}`)}  ` +
        `${c.broadcast ? 'broadcast' : D('unbroadcast')}`,
      );
      L.push(D(`    nVersion 0x${(c.nVersion >>> 0).toString(16).padStart(8, '0')}  env ${cut(c.envelopeHex, 40)}  ${envB}B ≤ ${OP_RETURN_RELAY_CAP_BYTES}B cap`));
    }
  }

  // stakes
  L.push('');
  L.push(B('STAKES') + D(`   floor ${FLOOR_BPS / 100}%/epoch · min DD output ${usd(MIN_OUTPUT_CENTS)} · ≤${MAX_PAYOUTS_PER_TX} payouts/tx`));
  L.push(D(`  ${pad('staker', 8)}${pad('free DD', 12)}${pad('locked', 12)}${pad('state', 10)}${pad('unlock', 9)}${pad('received', 11)}carry`));
  for (const s of stakers) {
    const st = epoch.stakes.find((x) => x.staker === s.name);
    L.push(
      `  ${B(pad(s.name, 8))}${pad(usd(s.balanceCents), 12)}` +
      `${pad(st ? usd(st.amountCents) : '—', 12)}${pad(st ? st.state : '—', 10)}` +
      `${pad(st ? st.bond.unlockHeight : '—', 9)}${pad(usd(s.receivedCents), 11)}` +
      `${epoch.carryCents[s.name] > 0 ? Y(usd(epoch.carryCents[s.name])) : D('$0.00')}`,
    );
    if (st) {
      L.push(D(`    bond leaf ${cut(st.bond.leafHex, 34)}  →  P2TR key ${cut(st.bond.outputKey, 20)}`));
    }
  }

  // log
  L.push('');
  L.push(B('LOG') + D('  (newest last)'));
  const tail = state.events.slice(-6);
  if (!tail.length) L.push(D('  —'));
  for (const e of tail) {
    const text = `  ${e.text}`;
    L.push(e.kind === 'alarm' ? R(text) : e.kind === 'reject' ? Y(text) : D(text));
  }

  // shortcuts
  L.push('');
  L.push(
    D('[') + B('1/2/3') + D('] alice/bob/carol lock   [') + B('t/T') + D('] tick +1/+10   [') +
    B('r') + D('] +revenue   [') + B('e') + D('] escrow floor   [') + B('k') + D('] delete escrow key'),
  );
  L.push(
    D('[') + B('g') + D('] rug   [') + B('b') + D('] broadcast distribution   [') + B('p') + D('] top-up   [') +
    B('x') + D('] early-unlock probe   [') + B('u') + D('] unlock bonds'),
  );
  L.push(
    D('[') + B('f') + D('] toggle freeze   [') + B('v') + D('] toggle operator vanished   [') +
    B('n') + D('] next epoch   [') + B('q') + D('] quit') +
    (lastKey ? D(`        last key: ${lastKey}`) : ''),
  );

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

let state = initialState();
const interactive = process.stdin.isTTY;

function render(lastKey) {
  if (interactive) console.clear();
  process.stdout.write(`${frame(state, lastKey)}\n`);
}

/** Returns false when the app should quit. */
function handleKey(ch) {
  if (ch === 'q' || ch === '\x03') return false;
  const action = KEYMAP[ch];
  if (action) ({ state } = dispatch(state, action));
  else {
    state = {
      ...state,
      events: [...state.events, { kind: 'reject', text: `no action bound to '${ch}'` }],
    };
  }
  render(ch);
  return true;
}

function quit() {
  if (interactive) process.stdin.setRawMode(false);
  process.stdout.write(D('\nprototype exited — nothing was persisted.\n') + '\n');
  process.exit(0);
}

if (interactive) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  render(null);
  process.stdin.on('data', (data) => {
    for (const ch of data) if (!handleKey(ch)) return quit();
  });
} else {
  // Piped: dispatch each character in order, frames printed sequentially.
  process.stdout.write(`${frame(state, null)}\n`);
  const run = async () => {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      for (const ch of chunk) {
        if (ch.trim() === '') continue; // spaces/newlines are separators, not keys
        process.stdout.write(D(`\n──────── key: ${JSON.stringify(ch)} ────────\n`));
        if (!handleKey(ch)) return quit();
      }
    }
    quit();
  };
  run();
}
