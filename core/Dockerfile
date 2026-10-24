# 构建上下文为仓库根目录：docker build -f core/Dockerfile .
# 基底 slim（glibc）：duckdb 的 Linux 预编译绑定只提供 glibc 版（musl 版已停发；
# 2026-10 实测 npm 在 alpine 上也会拿到 glibc 绑定 → 启动即 ERR_DLOPEN_FAILED），因此使用 slim。
# duckdb 钉死 1.4.3：1.4.4 的 Linux 绑定执行任意 SQL 即崩溃（Napi::Error: Do not know how to
# serialize a BigInt，已实测）——升级 duckdb 前必须在 Linux 容器里跑一次真实查询回归。
FROM node:20-slim AS build
WORKDIR /app/core
COPY core/package*.json ./
RUN npm ci
COPY core/ ./
RUN npm run build
COPY rules/ /app/assets/rules
COPY adapters/ /app/assets/adapters
COPY templates/ /app/assets/templates
COPY storage/ /app/assets/storage

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production SIME_ASSET_ROOT=/app/assets SIME_PORT=3000 SIME_PG_DDL_DIR=/app/assets/storage/pg/init SIME_LAKE_DIR=/app/data/lake
COPY --from=build /app/core/node_modules ./node_modules
COPY --from=build /app/core/dist ./dist
COPY --from=build /app/assets ./assets
RUN mkdir -p /app/data/lake
EXPOSE 3000
CMD ["node", "dist/main.js"]
