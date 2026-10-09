# molan-os 审查修复第十阶段报告

基线续作：`19766b0`（阶段 9 之后）  
本阶段目标：补齐阶段 9「仍受限」两项——可选原生 Postgres 应用驱动（含任务租约），以及按书隔离的物理备份恢复。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 改动 |
|---|---|
| 原生 Postgres 驱动 | `MOLAN_NATIVE_PG=1` + `DATABASE_URL`（或 `MOLAN_DB=postgres-native`）启用 `postgres-native`：`pgNativeClient` + worker 同步桥直连 `node-pg`，`?`→`$n`（`sqlCompat`）；**不再**走内存镜像整表刷盘 |
| 任务租约接线 | `tryAcquireJobLease` 在 `postgres-native` 下 `FOR UPDATE SKIP LOCKED` + 同谓词 UPDATE；`jobWorkerAllowedForDriver("postgres-native")` **允许** worker |
| 镜像模式保留 | 仅 `DATABASE_URL`、无 native 旗标 → 仍为实验镜像刷盘，默认拒开 worker |
| 按书物理备份 | wipe 前导出 `data/import-recovery/<bookId>.book.phys.sqlite`（仅该书行）；恢复 `restoreBookSnapshot`，**不影响同库其他书**；遗留整库 `.sqlite.phys` 仍可读 |

## 如何启用原生 Postgres

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
MOLAN_NATIVE_PG=1 \
  npm run dev:server
```

说明见 `docs/STORAGE_LEASE.md`。

## 如何跑

```bash
npm run typecheck
npm run test:regression
npm run test:e2e
npm run test:e2e:browser
MOLAN_LEASE_DATABASE_URL=postgres://molan:molan@127.0.0.1:5432/molan_lease \
  npm run test:pg-lease
npm run test:audit
```

## 实际测试（本机）

- `typecheck` 通过
- `test:regression` → **34/34**
- `test:e2e` → **67/67**（含按书隔离：恢复 A 不伤他书）
- `test:e2e:browser` → **43/43**
- `test:pg-lease`（真实 Postgres 17 + PGlite + native DbClient）→ **13/13**

## 仍受限 / 诚实边界

- 原生 PG 经 worker 同步桥实现 sync `DbClient`，适合可选部署；默认产品路径仍是 SQLite 单写者。
- 未做自动「从 SQLite 迁到 Postgres」的数据迁移工具；启用 native 前需自备空库或自迁。
- 遗留整库 `.sqlite.phys` 若仍存在，恢复仍会影响整库（新写入已改为按书 dump）。
- pi 仍明确不做自主工具编排；真实模型额度仍需 `MOLAN_LIVE_MODEL=1` + Key。

## 文档

- `docs/STORAGE_LEASE.md` — SQLite / 原生 PG / 镜像 / 按书物理备份
- `docs/PI_RUNTIME.md` — pi 边界（未改产品语义）
- `docs/LIVE_MODEL.md` — 可选 live 验收

本阶段代码 `2fc6866`；文档链至推送后 HEAD。
