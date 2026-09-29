# 快速上手

## 方式一：Docker（推荐）

```bash
docker compose up -d
curl http://localhost:3000/api/v1/health
```

预期返回：`{"status":"ok","assets":{"rules":9,"adapters":4,"thing-models":3},"assetErrors":0}`

## 方式二：本地运行 core（无需 Docker）

```bash
cd core
npm install
npm run build
npm start          # 监听 :3000
```

## 生成演示数据

```bash
python demo/generate.py --smoke              # CI 冒烟：20 设备 × 1 天
python demo/generate.py                      # 完整：500 设备 × 7 天 + 攻击场景
```

输出 `demo/out/`：`devices.jsonl`（台账）、`telemetry.jsonl`（遥测）、
`security-events.jsonl`（攻击回放：暴力破解 / 高频扫描 / WebShell / OT 越权写指令）。

## 声明式资产（贡献入口）

| 资产 | 目录 | Schema |
|---|---|---|
| 检测规则（六要素） | `rules/**/*.yaml` | `rules/schema/rule.schema.json` |
| 日志源适配器（三层） | `adapters/*.yaml` | `adapters/schema/adapter.schema.json` |
| 物模型模板 | `templates/thing-model/*.yaml` | `templates/thing-model/schema.json` |

校验：

```bash
cd core && npm run validate
```

提交新规则/适配器/模板 = 提交 PR，CI 会强制 Schema 校验与冒烟测试。

## 生成演示数据并回放

```bash
python demo/generate.py                 # 生成 demo/out/（500 设备 × 7 天 + 5 类攻击场景）
cd core && npm run replay -- ../demo/out/security-events.jsonl
```

回放输出即"5 分钟出告警"验收：55 条攻击事件 → 6 条告警（暴力破解横向移动 / 高频扫描 /
WebShell / OT 越权写指令 / 白名单外控制源 / 感染后暴力破解跨源链）。

## API 一览（M0/M0.5）

| 端点 | 说明 |
|---|---|
| `GET /api/v1/health` | 健康与资产加载统计 + 规则引擎状态 |
| `GET /api/v1/rules` / `GET /api/v1/rules/stats` | 规则清单与按域/类别/级别统计 |
| `GET /api/v1/adapters` | 适配器清单（厂商/协议/威胁字典数） |
| `GET /api/v1/thing-models` | 物模型模板清单 |
| `GET /api/v1/alerts` | 告警（内存态；设 `SIME_PG_HOST` 后持久化到 PG） |
| `GET /docs` | Swagger 契约文档（代码即契约） |

组件升级说明：本轮已评估并升级 @nestjs 12 / @nestjs/swagger 12 / js-yaml 5 / kysely 0.29
（构建+冒烟全绿）；TypeScript 7（原生编译器）与 @types/node 大版本暂不跟进，理由见蓝图 §4。
