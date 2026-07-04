// DigiDollar transaction envelope: nVersion marker + OP_RETURN mint metadata.
// Mirrors DigiByte Core v9.26.4 src/consensus/digidollar.cpp
// (HasDigiDollarMarker / GetDigiDollarTxType) and the on-wire OP_RETURN layout
// observed in real regtest mints (test/fixtures/mint-tx.json).

const DD_MARKER = 0x0770; // low 16 bits of nVersion
const TYPE_BY_CODE = { 1: 'mint', 2: 'transfer', 3: 'redeem' };
const CODE_BY_TYPE = { mint: 1, transfer: 2, redeem: 3 };

/** nVersion for a DigiDollar transaction of the given type ('mint'|'transfer'|'redeem'). */
export function buildDDVersion(type) {
  const code = CODE_BY_TYPE[type];
  if (!code) throw new RangeError(`unknown DigiDollar tx type: ${type}`);
  return (code << 24) | DD_MARKER;
}

/** Classify an nVersion: is it DigiDollar-marked, and which type. */
export function parseDDVersion(version) {
  if ((version & 0xffff) !== DD_MARKER) return { isDigiDollar: false, type: null };
  const code = (version >>> 24) & 0xff;
  return { isDigiDollar: true, type: TYPE_BY_CODE[code] ?? null };
}

// ---- Mint OP_RETURN metadata ----
// On-wire layout (from real regtest mints):
//   OP_RETURN(0x6a) push2 "DD"(0x4444) push1 <type> pushN <ddCents LE, minimal>
//   pushN <unlockHeight LE, minimal> push1 <lockTier> push32 <owner x-only key>
// All pushes are direct-length opcodes (1–75 bytes).

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function leMinimal(value) {
  // CScriptNum encoding: minimal signed little-endian. Zero is EMPTY (pushed
  // as OP_0); a set high bit on the top byte gets a 0x00 sign-padding byte.
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('negative value');
  if (v === 0n) return new Uint8Array(0);
  const out = [];
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Uint8Array.from(out);
}

const leToBigInt = (bytes) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);

function readPushes(script) {
  // Parse a script consisting of OP_RETURN followed by direct-length pushes.
  if (script[0] !== 0x6a) throw new RangeError('not an OP_RETURN script');
  const pushes = [];
  for (let i = 1; i < script.length; ) {
    const len = script[i];
    if (len > 75) throw new RangeError(`unsupported push opcode 0x${len.toString(16)} at ${i}`);
    pushes.push(script.subarray(i + 1, i + 1 + len)); // len 0 = OP_0 → empty push
    i += 1 + len;
  }
  return pushes;
}

/** Parse a mint OP_RETURN scriptPubKey (hex) into its fields. */
export function parseMintMetadata(scriptHex) {
  const pushes = readPushes(hexToBytes(scriptHex));
  const [magic, type, ddCents, unlockHeight, lockTier, ownerKey] = pushes;
  if (pushes.length !== 6 || bytesToHex(magic) !== '4444') throw new RangeError('not a DigiDollar metadata script');
  if (type.length !== 1 || type[0] !== CODE_BY_TYPE.mint) throw new RangeError(`not a mint metadata script (type ${type[0]})`);
  if (ownerKey.length !== 32) throw new RangeError('owner key must be 32 bytes');
  return {
    ddCents: leToBigInt(ddCents),
    unlockHeight: Number(leToBigInt(unlockHeight)),
    lockTier: Number(leToBigInt(lockTier)),
    ownerKeyHex: bytesToHex(ownerKey),
  };
}

// ---- Transfer OP_RETURN metadata ----
// On-wire layout (from real regtest transfers, test/fixtures/transfer-tx.json):
//   OP_RETURN(0x6a) push2 "DD"(0x4444) push1 <type=2> pushN <amountCents LE, minimal>...
// One CScriptNum amount per zero-value DD P2TR output, in output order
// (recipients first, DD change last). Consensus pairs them positionally
// (ValidateTransferTransaction in src/digidollar/validation.cpp).

/** Parse a transfer OP_RETURN scriptPubKey (hex) into its DD amounts (cents). */
export function parseTransferMetadata(scriptHex) {
  const pushes = readPushes(hexToBytes(scriptHex));
  const [magic, type, ...amounts] = pushes;
  if (pushes.length < 3 || bytesToHex(magic) !== '4444') throw new RangeError('not a transfer metadata script');
  if (type.length !== 1 || type[0] !== CODE_BY_TYPE.transfer) throw new RangeError(`not a transfer metadata script (type ${type[0]})`);
  return { amountsCents: amounts.map(leToBigInt) };
}

/** Build a transfer OP_RETURN scriptPubKey (hex) — byte-exact vs Core's encoding. */
export function buildTransferMetadata({ amountsCents }) {
  if (!amountsCents.length) throw new RangeError('at least one DD amount required');
  const push = (bytes) => [bytes.length, ...bytes];
  const parts = [0x6a, ...push([0x44, 0x44]), ...push([CODE_BY_TYPE.transfer])];
  for (const cents of amountsCents) {
    if (BigInt(cents) <= 0n) throw new RangeError('DD amounts must be positive');
    parts.push(...push(leMinimal(cents)));
  }
  return bytesToHex(Uint8Array.from(parts));
}

/** Build a mint OP_RETURN scriptPubKey (hex) — byte-exact vs Core's encoding. */
export function buildMintMetadata({ ddCents, unlockHeight, lockTier, ownerKeyHex }) {
  const ownerKey = hexToBytes(ownerKeyHex);
  if (ownerKey.length !== 32) throw new RangeError('owner key must be 32 bytes');
  const push = (bytes) => [bytes.length, ...bytes];
  const script = Uint8Array.from([
    0x6a,
    ...push([0x44, 0x44]),
    ...push([CODE_BY_TYPE.mint]),
    ...push(leMinimal(ddCents)),
    ...push(leMinimal(unlockHeight)),
    ...push(leMinimal(lockTier)),
    ...push(ownerKey),
  ]);
  return bytesToHex(script);
}
