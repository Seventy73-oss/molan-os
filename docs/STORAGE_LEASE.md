# 存储与任务租约说明

## 默认：SQLite

- 生产默认路径仍为本地 SQLite（`data/changjuan.sqlite`，可用 `MOLAN_SQLITE_PATH` 覆盖）。
- 批量任务租约写在 `writing_jobs.lease_owner` / `lease_until`（语义见 `server/src/jobs/lease.ts`）。
- 同一数据库文件上，HTTP `tick` 与后台 worker 通过租约互斥，避免双推进。
- 建议单进程写库；多进程同时打开同一 SQLite 文件仍可能锁等待，但不应用作横向扩展方案。

## 可选：原生 Postgres 应用驱动（阶段 10）

应用内可选择**真正对着 Postgres 跑 SQL**（不再是内存 SQLite 镜像整表刷盘）：

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
MOLAN_NATIVE_PG=1 \
  npm run dev:server
```

或等价：`MOLAN_DB=postgres-native` + `DATABASE_URL=...`。

| 项 | 行为 |
|---|---|
| SQL | 应用仍写 `?` 占位符；`server/src/db/pgNativeClient.ts` 转为 `$1..$n` 后经 worker 同步桥调 `node-pg` |
| 任务租约 | `tryAcquireJobLease` 在 `postgres-native` 下走 `FOR UPDATE SKIP LOCKED` + 同谓词 UPDATE |
| 任务 worker | **允许**启动（与 SQLite 同级） |
| 默认 | 未设 `MOLAN_NATIVE_PG=1` 时，`DATABASE_URL` 仍走旧的**镜像刷盘**实验模式 |

Markdown 导出布局（`data/books/`）不变；正式生成仍无服务端静默本地降级。

## Postgres 租约单测（lease harness）

- 共享 SQL / 纯函数：`server/src/jobs/lease.ts`
- 原生实现：`server/src/jobs/pgNativeLease.ts`
- 验收：

```bash
MOLAN_LEASE_DATABASE_URL=postgres://molan:molan@127.0.0.1:5432/molan_lease \
  npm run test:pg-lease
```

- 真实 Postgres 不可达时：脚本对「真实 Postgres 可达」记软跳过，并仍跑 **PGlite 同实例** SQL 语义。

## 镜像 Postgres / PGlite（实验）

- `DATABASE_URL` **不带** `MOLAN_NATIVE_PG=1`，或 `MOLAN_DB=pglite`：内存镜像整表刷盘。
- **不能**把镜像上的租约列当成跨进程锁。
- 默认拒绝启动任务 worker；单进程例外：`MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1`。

## 覆盖导入与崩溃恢复

### 逻辑 JSON（一级）

- 覆盖导入前把原书逻辑快照落到 `data/import-recovery/<bookId>.json`（临时文件 + fsync + rename）。
- 导入成功或逻辑回滚成功后删除。
- 进程在 wipe 与 restore 之间被杀死：下次启动 `recoverInterruptedImports()` 从 JSON 还原并 `syncBook`。
- JSON 损坏 → `data/import-recovery/corrupt/`。

### 按书物理 SQLite 备份（二级，阶段 10）

- wipe 前把**仅该书**相关行导出为独立 SQLite：
  - `data/import-recovery/<bookId>.book.phys.sqlite`
  - 标记：`data/import-recovery/<bookId>.book.phys.pending`
- 恢复时 `restoreBookSnapshot` **只动该书**，同库其他书不受影响。
- 逻辑回滚成功或导入成功后清除。
- 逻辑 JSON 仍优先；无 JSON 时才走物理按书恢复。

### 遗留：整库 `.sqlite.phys`（阶段 9 → 阶段 11 收紧）

- 新写入不再生成整库副本（阶段 10 起为按书 `.book.phys.sqlite`）。
- 启动若仍发现 `<bookId>.sqlite.phys` + `.phys.pending`：
  1. **优先转换**为按书 dump，再 `restoreBookSnapshot`（**不动其他书**）；
  2. 无法抽出该书 → **拒绝**整库替换，并将遗留文件移入 `data/import-recovery/legacy-quarantine/`；
  3. **不会**再自动 `replaceSqliteFromPhysicalBackup`（避免静默覆盖同库其他书）。
- 手写灾难恢复仍可用 `replaceSqliteFromPhysicalBackup`（仅脚本/人工，不走启动自动路径）。

### SQLite → 原生 Postgres 迁移（阶段 11）

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
  npm run migrate:sqlite-to-pg -- --dry-run
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/molan \
  npm run migrate:sqlite-to-pg -- --force   # 目标已有书时需显式 force
```

- 默认读 `MOLAN_SQLITE_PATH` 或 `data/changjuan.sqlite`；`--sqlite <path>` 可覆盖。
- 目标已有 `books` 且未 `--force` → 拒绝迁移（防误覆盖）。
- 迁移**不会**自动改 boot 驱动；迁完后自行 `MOLAN_NATIVE_PG=1` 启动。
- Markdown `data/books/` 布局不变，无需随库迁移。

## 取消与暂停语义（回顾）

- **暂停**：当前阶段可完成推进指针，状态保持 `paused`。
- **取消（批量任务）**：成稿以候选修订写入，不覆盖当前稿。
- **取消（流式 generation）**：abort + `POST /api/generations/:id/cancel`；已完成后再停止不 demote。
