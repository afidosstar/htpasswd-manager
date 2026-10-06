# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# htpasswd-manager — image de production (Alpine, non-root, sans npm/yarn)
# Astuce : en production, épinglez l'image de base par digest
#   (ex. node:24-alpine@sha256:…) et reconstruisez régulièrement.
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:24-alpine

# --- Étape 1 : dépendances de production uniquement --------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# --- Étape 2 : compilation TypeScript + tests (le build échoue si un test régresse)
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin
COPY test ./test
RUN npm run typecheck && npm test

# --- Étape 3 : runtime minimal ------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="htpasswd-manager" \
      org.opencontainers.image.description="Gestion web d'un fichier htpasswd (Mailpit / Apache / Nginx)" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HTPASSWD_PATH=/data/passwords \
    PORT=8080

# tini : PID 1 propre (signaux, zombies). Suppression de npm/yarn/corepack :
# inutiles à l'exécution et source récurrente de CVE.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data && chown node:node /data && chmod 0750 /data

WORKDIR /app
# Code appartenant à root, en lecture seule pour l'utilisateur d'exécution.
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --from=build --chown=root:root /app/dist ./dist
# Outil pour les services consommateurs (Mailpit…), à extraire et fournir par config Swarm :
#   docker run --rm --entrypoint cat afidos/htpasswd-manager:<version> /usr/local/bin/htpasswd-watch
COPY --chown=root:root --chmod=0755 bin/htpasswd-watch /usr/local/bin/htpasswd-watch

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
