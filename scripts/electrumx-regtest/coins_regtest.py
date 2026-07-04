# DigiByte regtest coin class for stock ElectrumX (#4: extend, don't fork).
# ElectrumX's lookup scans members of the electrumx.lib.coins MODULE (not the
# subclass registry), so the class must be injected into that module's
# namespace — the setattr at the bottom is the whole "registration".
import electrumx.lib.coins as coins


class DigiByteRegtest(coins.DigiByte):
    NET = "regtest"
    # regtest shares testnet's address version bytes
    P2PKH_VERBYTE = bytes.fromhex("7e")
    P2SH_VERBYTES = (bytes.fromhex("8c"),)
    # deterministic regtest genesis (verified against DigiByte-Qt v9.26.4 getblockhash 0)
    GENESIS_HASH = "4598a0f2b823aaf9e77ee6d5e46f1edb824191dcd48b08437b7cec17e6ae6e26"
    PEERS = []
    REORG_LIMIT = 200


coins.DigiByteRegtest = DigiByteRegtest
