# 存储与任务租约说明

## 默认：SQLite

- 生产默认路径仍为本地 SQLite（`data/changjuan.sqlite`，可用 `MOLAN_SQLITE_PATH` 覆盖）。
- 批量任务租约写在 `writing_jobs.lease_owner` / `lease_until`（语义见 `server/src/jobs/lease.ts`）。
- 同一数据库文件上，HTTP `tick` 与后台 worker 通过租约互斥，避免双推进。
- 建议单进程写库；多进程同时打开同一 SQLite 文件仍可能锁等待，但不应用作横向扩展方案。

## Postgres 原生租约（已测）

- 共享 SQL / 纯函数：`server/src/jobs/lease.ts`
- 原生实现（`FOR UPDATE SKIP LOCKED` + 同谓词 UPDATE）：`server/src/jobs/pgNativeLease.ts`
- **验收脚本**（可接真实 Postgres 多会话）：

```bash
# 本机示例（需已创建库与用户）
MOLAN_LEASE_DATABASE_URL=postgres://molan:molan@127.0.0.1:5432/molan_lease \
  npm run test:pg-lease
```

- 真实 Postgres 不可达时：脚本对「真实 Postgres 可达」记软跳过，并仍跑 **PGlite 同实例** SQL 语义；**不宣称**已具备集群。
- 应用主路径仍默认 SQLite。`DATABASE_URL` / `MOLAN_DB=pglite` 仍是**内存镜像整表刷盘**实验模式，**不能**把镜像上的租约列当成跨进程锁。
- **默认行为**：`driver=postgres|pglite` 时拒绝启动任务 worker；单进程例外：`MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1`。
- 完整原生 Postgres 驱动替换镜像刷盘仍不在默认产品路径；横向扩展请继续 SQLite 单写者，或外接队列 + 本仓库已验证的 PG lease SQL。

## 覆盖导入与崩溃恢复

### 逻辑 JSON（一级）

- 覆盖导入前把原书逻辑快照落到 `data/import-recovery/<bookId>.json`（临时文件 + fsync + rename）。
- 导入成功或逻辑回滚成功后删除。
- 进程在 wipe 与 restore 之间被杀死：下次启动 `recoverInterruptedImports()` 从 JSON 还原并 `syncBook`。
- JSON 损坏 → `data/import-recovery/corrupt/`。

### 物理 SQLite 备份（二级）

- **同一时刻**在 wipe 前复制整库文件到：
  - `data/import-recovery/<bookId>.sqlite.phys`
  - 以及同名 `-wal` / `-shm`（若存在）
  - 标记：`data/import-recovery/<bookId>.phys.pending`
- 逻辑回滚成功或导入成功后清除物理备份。
- 逻辑回滚失败时保留物理文件；启动时 `recoverPhysicalImportBackups()` 在 **无可用 JSON** 时关闭并替换 live SQLite 后重开。
- 物理恢复影响**整库**（不只当前书），仅作灾难兜底。

## 取消与暂停语义（回顾）

- **暂停**：当前阶段可完成推进指针，状态保持 `paused`。
- **取消（批量任务）**：成稿以候选修订写入，不覆盖当前稿。
- **取消（流式 generation）**：abort + `POST /api/generations/:id/cancel`；已完成后再停止不 demote。
