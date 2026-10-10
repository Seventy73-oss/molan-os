# molan-os 审查修复第十一阶段报告

基线续作：`8288f31`（阶段 10 之后）  
本阶段目标：补齐阶段 10「仍受限」两项——SQLite→原生 Postgres 迁移工具，以及收紧遗留整库 `.sqlite.phys` 自动恢复（禁止静默覆盖同库其他书）。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 改动 |
|---|---|
| SQLite→PG 迁移 | `server/src/db/migrateSqliteToPg.ts` + CLI `npm run migrate:sqlite-to-pg`；按表顺序拷贝、列交集、artifacts 先空 `current_revision_id` 再回填；目标已有书且无 `--force` → 拒绝；`--dry-run` 只计数 |
| 遗留整库 phys | 启动恢复**不再**调用 `replaceSqliteFromPhysicalBackup`；优先 `convertLegacyWholeDbPhysToPerBook` → 按书 `restoreBookSnapshot`；抽不出该书 → **拒绝**并移入 `data/import-recovery/legacy-quarantine/` |
| 文档 | `docs/STORAGE_LEASE.md` 更新遗留 phys 与迁移用法 |

## 如何迁移到原生 Postgres

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
  npm run migrate:sqlite-to-pg -- --dry-run
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
  npm run migrate:sqlite-to-pg -- --force
# 迁完后自行启用：
MOLAN_NATIVE_PG=1 DATABASE_URL=... npm run dev:server
```

`--sqlite <path>` 可覆盖源库（默认 `MOLAN_SQLITE_PATH` / `data/changjuan.sqlite`）。  
`data/books/` Markdown 布局不变，无需随库迁移。

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
- `test:regression` → **37/37**
- `test:e2e` → **73/73**（含遗留整库转换恢复不伤他书、抽不出书时拒绝）
- `test:e2e:browser` → **43/43**
- `test:pg-lease`（真实 Postgres 17 + migrate smoke）→ **17/17**

## 仍受限 / 诚实边界

- 迁移工具不做增量双向同步；目标非空需 `--force`（按主键 upsert），不会自动改 boot 驱动。
- `replaceSqliteFromPhysicalBackup` 仍保留给人工灾难脚本，但**启动自动恢复不会调用**。
- 原生 PG 仍经 worker 同步桥；默认产品路径仍是 SQLite。
- pi 仍明确不做自主工具编排；真实模型额度仍需 `MOLAN_LIVE_MODEL=1` + Key。

## 文档

- `docs/STORAGE_LEASE.md` — 迁移 CLI、遗留 phys 转换/拒绝
- `docs/PI_RUNTIME.md` / `docs/LIVE_MODEL.md` — 未改产品语义

本阶段代码与文档见仓库 HEAD（提交后回填）。
