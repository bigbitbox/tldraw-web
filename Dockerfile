FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
ARG APP_ENV=development
ENV APP_ENV=$APP_ENV
RUN --mount=type=secret,id=tldraw_license \
    if [ "$APP_ENV" = production ]; then test -s /run/secrets/tldraw_license; fi && \
    export VITE_TLDRAW_LICENSE_KEY="$(cat /run/secrets/tldraw_license 2>/dev/null || true)" && \
    npm run check && npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ARG APP_ENV=development
ENV NODE_ENV=$APP_ENV APP_ENV=$APP_ENV DATA_DIR=/data PORT=5858
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build /app/package.json ./
USER node
EXPOSE 5858
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:5858/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
