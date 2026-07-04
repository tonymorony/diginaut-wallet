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


class DigiByteTestnet(coins.DigiByte):
    NET = "testnet"
    P2PKH_VERBYTE = bytes.fromhex("7e")  # 126
    P2SH_VERBYTES = (bytes.fromhex("8c"),)  # 140
    # from DigiByte v9.26.4 src/kernel/chainparams.cpp CTestNetParams
    GENESIS_HASH = "0c9af936f28f7bd0e90c8f6235399063a026ed267bb53da398313b5d7aa55d82"
    PEERS = []
    REORG_LIMIT = 2000


coins.DigiByteRegtest = DigiByteRegtest
coins.DigiByteTestnet = DigiByteTestnet
