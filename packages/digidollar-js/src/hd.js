// HD wallet layer: BIP39 mnemonic → BIP32 seed → BIP86 taproot keys.
// Thin, audited primitives from @scure (same maintainer as @noble); this module
// only fixes the wordlist and DigiByte-specific parameters around them.

import { mnemonicToSeedSync, generateMnemonic as bip39Generate, validateMnemonic as bip39Validate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { ddTokenOutputKey } from './taproot.js';
import { encodeWitnessAddress } from './address.js';

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// hrp per BIP-173; coin type 20 is DigiByte's SLIP-44 entry, test networks use 1.
export const HD_NETWORKS = Object.freeze({
  mainnet: Object.freeze({ hrp: 'dgb', coinType: 20 }),
  testnet: Object.freeze({ hrp: 'dgbt', coinType: 1 }),
  regtest: Object.freeze({ hrp: 'dgbrt', coinType: 1 }),
});

/** Fresh 12-word english mnemonic (128 bits from the platform CSPRNG). */
export function generateMnemonic() {
  return bip39Generate(wordlist, 128);
}

/** True iff the mnemonic is valid english BIP39 (wordlist + checksum). */
export function validateMnemonic(mnemonic) {
  return bip39Validate(mnemonic, wordlist);
}

/** BIP39 seed from an english mnemonic (sync PBKDF2 — fine in browser and Node). */
export function mnemonicToSeed(mnemonic, passphrase = '') {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * BIP86 taproot key + address at m/86'/coinType'/account'/change/index.
 * The output key is the key-path-only tap tweak — identical to Core's
 * CreateDigiDollarP2TR, so a mint to this address is redeemable by this key.
 */
export function deriveTaprootAddress(seed, { hrp, coinType, account = 0, change = 0, index = 0 }) {
  const path = `m/86'/${coinType}'/${account}'/${change}/${index}`;
  const node = HDKey.fromMasterSeed(seed).derive(path);
  const internalKeyHex = bytesToHex(node.publicKey.slice(1)); // x-only: drop the parity byte
  const outputKeyHex = ddTokenOutputKey(internalKeyHex);
  return {
    path,
    privKeyHex: bytesToHex(node.privateKey),
    internalKeyHex,
    outputKeyHex,
    address: encodeWitnessAddress(hrp, 1, outputKeyHex),
  };
}
