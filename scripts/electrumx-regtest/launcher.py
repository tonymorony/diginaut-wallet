#!/usr/bin/env python3
# Start stock ElectrumX with the DigiByte regtest coin registered.
import coins_regtest  # noqa: F401  (registers DigiByteRegtest via subclassing)

from electrumx.server.controller import Controller
from electrumx.server.env import Env
import asyncio
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")


async def main():
    env = Env()
    controller = Controller(env)
    await controller.run()


asyncio.run(main())
