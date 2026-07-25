# One image for the three Node services (wallet / indexer / faucet).
# Build from the REPO ROOT with the app selected at build time:
#   docker build -f deploy/node.Dockerfile --build-arg APP=wallet .
#
# Pinned by DIGEST, not by tag: this image runs the process that signs
# transactions and serves the crypto libraries into the page, and `up --build`
# on a floating tag can change the Node runtime under it without a single
# line of this repo changing.
#
# Stay on an LTS line, and keep this in step with .nvmrc — CI runs the suites on
# .nvmrc, so a Dockerfile ahead of it means production runs a Node that nothing
# ever tested. That is exactly what happened in #120, which took this image to
# node:26 (the Current line, not LTS) while .nvmrc still said 22.
#
# To move within the line:
#   docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' node:24-alpine
# then bump the digest here, bump .nvmrc to match, run the unit suites + the CDP
# drivers, and deploy.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

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
