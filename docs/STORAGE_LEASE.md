# 存储与任务租约说明

## 默认：SQLite

- 生产默认路径仍为本地 SQLite。
- 批量任务租约写在 `writing_jobs.lease_owner` / `lease_until`。
- 同一数据库文件上，HTTP `tick` 与后台 worker 通过租约互斥，避免双推进。
- 建议单进程写库；多进程同时打开同一 SQLite 文件仍可能锁等待，但不应用作横向扩展方案。

## Postgres / PGlite（实验性）

- 当前实现仍以**内存 SQLite 镜像 + 整表刷盘**为主，**不适合多进程生产**。
- **未验证**跨进程 Postgres advisory lock / row lease；两个进程各自持有独立镜像，租约列无法互斥。
- **默认行为**：`driver=postgres|pglite` 时**拒绝启动**任务 worker，并在启动日志中告警。
- **单进程例外**：仅当确认全局只有一个 Node 进程时，可设置  
  `MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1`  
  强制开启 worker。多 worker / 多副本严禁使用该开关。
- 完整增量 Postgres 驱动与集群 lease 不在本仓库当前范围；需要横向扩展时请继续用 **SQLite 单写者**，或自备外部队列。

## 覆盖导入与崩溃恢复

- 覆盖导入前会把原书逻辑快照落到 `data/import-recovery/<bookId>.json`（先写临时文件再 rename）。
- 导入成功或内存回滚成功后删除该文件。
- 若进程在 wipe 与 restore 之间被杀死，下次启动 `recoverInterruptedImports()` 会尝试从该文件还原书库并 `syncBook`。
- **人工恢复**：若启动恢复仍失败，保留该 JSON，核对 `data/books/<bookId>/` 与 SQLite 后，可把文件移出目录再重启，或在维护环境用快照回灌逻辑恢复。

## 取消与暂停语义（回顾）

- **暂停**：当前阶段可完成推进指针，状态保持 `paused`，不会偷偷变回 `running`。
- **取消**：不再推进；阶段结束时若已取消，成稿以候选修订写入（`asCandidate`），不覆盖当前稿。
