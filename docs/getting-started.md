# 快速上手

> 生产部署、端口规划、环境变量、升级回滚、备份与故障排查见 **[deployment.md](deployment.md)**。本文只讲最短路径。
> 跨源检索用 **SIME QL**（`POST /api/v1/query`），语法与字段目录见 **[sime-ql.md](sime-ql.md)**。
> 原始事件怎么进来、怎么查，见 **[ingest.md](ingest.md)**。
> 日志保留与数据导出见 **[operations.md](operations.md)**。

## 方式一：Docker（推荐）

```bash
bash deploy/install.sh          # 或 docker compose --profile sim up -d --build
```

打开控制台：`http://<主机IP>:${SIME_HTTP_PORT:-3000}/ui`
（概览 / 实时告警 / 事件检索 / 安全查询 SIME QL / 设备遥测 / 组态总览 / 规则库 / 适配与物模型 / 处置闭环 / 数据湖 / AI 助手）
（默认 **admin / sime123456**，生产务必用 `SIME_ADMIN_PASSWORD` 与 `SIME_AUTH_SECRET` 覆盖；若 3000 被占用，在 `.env` 设 `SIME_HTTP_PORT=13000`）。

## 方式二：本地运行 core（无需 Docker）

```bash
cd core
npm install
npm run build
npm start        # 控制台 /ui · 文档 /docs · API /api/v1
```

## 生成演示数据并回放

```bash
python3 demo/generate.py                 # 模拟园区 500 设备 × 7 天 + 攻击场景
cd core && npm run replay -- ../demo/out/security-events.jsonl
```

或启用常驻设备模拟器（EMQX + 周期攻击突发，页面即有活数据）：

```bash
docker compose --profile sim up -d
```

## 声明式资产（贡献入口）

| 资产 | 目录 | Schema |
|---|---|---|
| 检测规则（六要素 + ATT&CK） | `rules/**/*.yaml` | `rules/schema/rule.schema.json` |
| 日志源适配器（三层） | `adapters/*.yaml` | `adapters/schema/adapter.schema.json` |
| 物模型模板 | `templates/thing-model/*.yaml` | `templates/thing-model/schema.json` |
| SOAR 剧本 | `templates/playbooks/*.yaml` | `templates/playbooks/schema.json` |

```bash
cd core && npm run validate      # Schema 全量校验 + 适配器样例回归
```

## 命令速查（core/）

| 命令 | 说明 |
|---|---|
| `npm test` | 冒烟：资产校验 + 适配器回归 + 引擎回放 + 性能地板 |
| `npm run bench` | 机制基准（规则引擎 EPS / 适配器 maps/s） |
| `npm run e2e` | 端到端回归（对运行中平台，29 项检查） |
| `npm run replay -- <events.jsonl>` | 事件回放出告警 |
| `npm run sim -- --loop` | 设备模拟器（遥测 + 周期攻击突发） |

## API 一览

| 端点 | 说明 |
|---|---|
| `GET /api/v1/health` | 健康（免认证） |
| `POST /api/v1/auth/login` | 登录取 token（默认 admin/sime123456） |
| `GET /api/v1/rules` `GET /api/v1/rules/stats` | 规则清单与统计 |
| `GET /api/v1/adapters` `GET /api/v1/thing-models` | 适配器 / 物模型 |
| `GET /api/v1/alerts` `POST /api/v1/alerts/{id}/ack` `.../resolve` | 告警与闭环 |
| `GET /api/v1/alerts/trend` | 24h 趋势 |
| `POST /api/v1/pipeline/simulate` | 一键攻击回放 |
| `GET /api/v1/telemetry/latest` `/series` `/devices` | 遥测查询 |
| `GET/POST /api/v1/topology/layout` | 组态布局 |
| `GET /api/v1/playbooks` `GET /api/v1/responses` | 剧本 / 处置闭环 |
| `GET /api/v1/lake/status` `POST /api/v1/lake/snapshot` `POST /api/v1/lake/query` | 数据湖 |
| `POST /api/v1/query/sources` `POST /api/v1/query` `POST /api/v1/query/validate` | **SIME QL** 统一查询（见 [sime-ql.md](sime-ql.md)；控制台「安全查询」视图即此能力的图形面） |
| `GET /api/v1/retention` `POST /api/v1/retention/run` | 日志保留策略与清理（见 [operations.md](operations.md)） |
| `GET /api/v1/export` `POST /api/v1/export` `GET /api/v1/export/catalog` | 数据导出 CSV / JSONL（见 [operations.md](operations.md)） |
| `GET /api/v1/events` `GET /api/v1/events/stats` `GET /api/v1/events/:id` | 事件检索（列表 / 分布 / 详情） |
| `POST /api/v1/ingest/events` `POST /api/v1/ingest/import` `GET /api/v1/ingest/stats` | 事件摄入：直推 / 流量包导入 / 计数（见 [ingest.md](ingest.md)） |
| `GET /docs` | Swagger |

除 `/health` 与 `/auth/login` 外均需 `Authorization: Bearer <token>`。
