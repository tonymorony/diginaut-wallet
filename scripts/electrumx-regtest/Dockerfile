# Stock ElectrumX + a DigiByte regtest coin class (no fork — see #4).
FROM python:3.12-slim

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
