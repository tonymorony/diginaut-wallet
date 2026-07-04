# One image for the three Node services (wallet / indexer / faucet).
# Build from the REPO ROOT with the app selected at build time:
#   docker build -f deploy/node.Dockerfile --build-arg APP=wallet .
FROM node:22-alpine

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
USER node
CMD node apps/${APP}/server.js
