# Stock ElectrumX + a DigiByte regtest coin class (no fork — see #4).
# Digest-pinned like deploy/node.Dockerfile: a regtest stand that silently
# changes Python underneath is a test result you cannot trust. Refresh with
#   docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' python:3.12-slim
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

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
