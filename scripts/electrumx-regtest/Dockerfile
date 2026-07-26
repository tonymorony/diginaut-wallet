# Stock ElectrumX + a DigiByte regtest coin class (no fork — see #4).
# Digest-pinned like deploy/node.Dockerfile: a regtest stand that silently
# changes Python underneath is a test result you cannot trust. Refresh with
#   docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' python:3.14-slim
# 3.14 verified 2026-07-26: e-x 2.0.0 declares 3.14 support and plyvel 1.5.1 has
# no cp314 wheel but compiles from its sdist against the libleveldb-dev above.
FROM python:3.14-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libleveldb-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir e-x plyvel

WORKDIR /app
COPY coins_regtest.py launcher.py ./

ENV COIN=DigiByte \
    NET=regtest \
    DB_ENGINE=leveldb \
    DB_DIRECTORY=/data \
    SERVICES=tcp://0.0.0.0:50001 \
    COST_SOFT_LIMIT=0 \
    COST_HARD_LIMIT=0

RUN useradd -m electrumx && mkdir -p /data && chown electrumx /data
USER electrumx

VOLUME /data
EXPOSE 50001
CMD ["python", "launcher.py"]
