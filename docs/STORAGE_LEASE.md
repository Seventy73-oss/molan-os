# 存储与任务租约说明

## 默认：SQLite

- 生产默认路径仍为本地 SQLite。
- 批量任务租约写在 `writing_jobs.lease_owner` / `lease_until`。
- 同一数据库文件上，HTTP `tick` 与后台 worker 通过租约互斥，避免双推进。
- 建议单进程写库；多进程同时打开同一 SQLite 文件仍可能锁等待，但不应用作横向扩展方案。

## Postgres / PGlite（实验性）

- 当前实现仍以内存 SQLite 镜像 + 刷盘为主，**不适合多进程生产**。
- **未验证**跨进程 Postgres advisory lock / row lease。
- 若启用 Postgres：请限制为**单 worker 单进程**，并把模式视为实验性。
- 完整增量 Postgres 驱动与集群 lease 不在本阶段范围。

## 取消与暂停语义（回顾）

- **暂停**：当前阶段可完成推进指针，状态保持 `paused`，不会偷偷变回 `running`。
- **取消**：不再推进；阶段结束时若已取消，成稿以候选修订写入（`asCandidate`），不覆盖当前稿。
