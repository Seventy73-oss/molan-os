# molan-os 审查修复第三阶段报告

基线续作：`8c64a8b`（阶段 1–2 之后）  
测试：`npm run test:regression` → **26/26**；`npm run test:e2e` → **18/18**；`npm run typecheck` 通过。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| T10 余项 | 流式取消未贯通上下游 | `abortUtil`；`RunInput.signal`；OpenAI `secureFetch`+读流取消；`emitChunked`/`streamSupport`/`chat`/`executeScene` 传 AbortSignal；断连用 `c.req.raw.signal`；`POST /api/generations/:id/cancel` |
| 覆盖导入回滚 | 失败后可能半成品书 | 覆盖前 `snapshotBook`；失败 `restoreBookSnapshot`；测试钩 `MOLAN_IMPORT_FAIL_AFTER_WIPE=1` |
| 任务租约 | 仅内存 Set | `writing_jobs.lease_owner` / `lease_until`；`tryAcquireJobLease` / `releaseJobLease`；`withJobLock` 双保险 |
| 取消写稿 | 取消后仍可能设当前稿 | `tickJob` 阶段用 `asCandidate: () => jobLease==='stop'` |
| E2E | 缺慢请求/并发/SSE/重启等验收 | `server/scripts/e2e-audit.mts`（API 级，mock/local-draft） |

## 数据迁移与兼容性

- SQLite / Postgres：`writing_jobs` 增加可空列 `lease_owner`、`lease_until`（`ADD COLUMN`，不删历史）。
- 书稿 md 目录结构不变。
- 覆盖导入回滚恢复章节/修订/消息/设定卡/钩子；进行中的任务恢复为 `paused`，不自动续跑。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 18/18
```

E2E 覆盖：慢/并发 CAS、迟到候选稿、SSE 丢回执后 generation 复用、同库“重启”读回、AbortSignal、cancelGeneration、暂停/取消 tick、SQLite lease 互斥、覆盖导入失败回滚、快照还原。

## 仍受限 / 未验证

- **浏览器 UI E2E（Playwright）**：本阶段用 API/引擎级复现同等语义；未跑真实浏览器点击。
- **Postgres 多进程 lease**：Postgres/PGlite 仍为实验性镜像刷盘；未接真 Postgres 集群。多进程请只用 SQLite 单写者，或自备单 worker。说明见 `docs/STORAGE_LEASE.md`。
- **真实模型额度 / 实网 DNS rebinding**。
- **pi** 仍为代调模型，不是自主工具编排。
- 覆盖导入回滚是逻辑快照，不是文件系统级整库备份；极端进程杀死可能落在 wipe 与 restore 之间（下次启动需人工核对）。

## 可复现回归

```bash
npm run test:audit   # regression + e2e
```
