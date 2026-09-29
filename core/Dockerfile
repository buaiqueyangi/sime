# 构建上下文为仓库根目录：docker build -f core/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app/core
COPY core/package*.json ./
RUN npm ci
COPY core/ ./
RUN npm run build
COPY rules/ /app/assets/rules
COPY adapters/ /app/assets/adapters
COPY templates/ /app/assets/templates
COPY storage/ /app/assets/storage

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production SIME_ASSET_ROOT=/app/assets SIME_PORT=3000 SIME_PG_DDL_DIR=/app/assets/storage/pg/init
COPY --from=build /app/core/node_modules ./node_modules
COPY --from=build /app/core/dist ./dist
COPY --from=build /app/assets ./assets
EXPOSE 3000
CMD ["node", "dist/main.js"]
