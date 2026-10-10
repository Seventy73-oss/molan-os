# molan-os 审查修复第十二阶段报告

基线续作：`ec3065d`（阶段 11 之后）  
本阶段目标：收口阶段 11「仍受限」——幂等可重复 SQLite→PG 同步、整库 phys 脚本路径弃用/隔离、审查收口文档。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 改动 |
|---|---|
| 迁移幂等 | `migrateSqliteToPg` 增加 `--sync`（`--force` 为别名）；`ON CONFLICT DO UPDATE`；可反复跑；无 sync 且目标有书 → 拒绝；**不做 prune**（PG 孤儿行保留） |
| 整库 phys 弃用 | `replaceSqliteFromPhysicalBackup` 默认拒绝，需 `MOLAN_ALLOW_WHOLE_DB_PHYS_RESTORE=1`；`quarantineOrphanLegacyWholeDbPhys` + `npm run quarantine:legacy-phys` |
| 收口文档 | `docs/AUDIT_CLOSURE.md`；本报告；`docs/STORAGE_LEASE.md` 更新 |

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

迁移 / 隔离：

```bash
DATABASE_URL=... npm run migrate:sqlite-to-pg -- --sync
npm run quarantine:legacy-phys
```

## 实际测试（本机）

- `typecheck` 通过
- `test:regression` → **42/42**
- `test:e2e` → **75/75**
- `test:e2e:browser` → **43/43**
- `test:pg-lease` → **21/21**

## 仍受限 / 诚实边界

- 迁移不做双向增量 / 不做 PG→SQLite / 不做 prune。
- 整库 phys 仍可在显式 env 下调用（仅灾难）；产品路径只用按书 dump。
- 默认产品仍是 SQLite；pi 仍为模型代调；live-model 仍 opt-in。

## 文档

- `docs/AUDIT_CLOSURE.md` — 全阶段收口
- `docs/STORAGE_LEASE.md` — sync / quarantine
- `docs/PI_RUNTIME.md` / `docs/LIVE_MODEL.md` — 产品选择未变

本阶段代码待 commit 后回填 HEAD。
