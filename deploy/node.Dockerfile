# One image for the three Node services (wallet / indexer / faucet).
# Build from the REPO ROOT with the app selected at build time:
#   docker build -f deploy/node.Dockerfile --build-arg APP=wallet .
#
# Pinned by DIGEST, not by tag: this image runs the process that signs
# transactions and serves the crypto libraries into the page, and `up --build`
# on a floating tag can change the Node runtime under it without a single
# line of this repo changing. To move to a newer Node 22:
#   docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' node:22-alpine
# then bump the digest here, run the unit suites + the CDP drivers, and deploy.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /repo
# Workspace manifests first so `npm ci` layers cache across code edits.
COPY package.json package-lock.json ./
COPY packages/digidollar-js/package.json packages/digidollar-js/
COPY apps/wallet/package.json apps/wallet/
COPY apps/indexer/package.json apps/indexer/
COPY apps/faucet/package.json apps/faucet/
RUN npm ci --omit=dev

COPY packages ./packages
COPY apps ./apps

ARG APP=wallet
ENV APP=${APP}
# /data must be node-owned BEFORE the volume is created from it, or the faucet
# (USER node) gets EACCES writing its claim ledger to a root-owned named volume.
RUN mkdir -p /data && chown node:node /data
USER node
CMD node apps/${APP}/server.js
