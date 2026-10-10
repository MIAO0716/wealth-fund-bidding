# 构建阶段
FROM node:22.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev --ignore-scripts

# 运行阶段：基于官方 postgres:16 镜像，以便自动检查点使用同版本 pg_dump
FROM postgres:16.6-bookworm
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
COPY scripts scripts
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIST=/app/apps/web/dist \
    MIGRATIONS_DIR=/app/apps/server/migrations \
    BACKUP_DIR=/backups
RUN mkdir -p /backups && chown postgres:postgres /backups
USER postgres
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT []
CMD ["node", "apps/server/dist/main.js"]
