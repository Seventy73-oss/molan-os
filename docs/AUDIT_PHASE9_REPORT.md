# molan-os 审查修复第九阶段报告

基线续作：`c9c3b0d`（阶段 8 之后）  
本阶段目标：按规划补齐此前「仍受限」四项（能在本机自动化验收的部分）。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 改动 |
|---|---|
| Postgres 多会话租约 | 抽出 `server/src/jobs/lease.ts`（与 SQLite 同谓词）；`pgNativeLease.ts` 用 `FOR UPDATE SKIP LOCKED` + lease 列；`npm run test:pg-lease` 对**真实 Postgres** 做互斥 / 过期 / 跨会话锁，并对 PGlite 跑同实例语义。应用主路径仍默认 SQLite；镜像 PG 默认拒开 worker |
| 覆盖导入物理库备份 | wipe 前复制 `data/import-recovery/<bookId>.sqlite.phys`（+wal/shm）与 `.phys.pending`；逻辑 JSON 仍为一级；逻辑回滚失败保留物理文件；启动 `recoverPhysicalImportBackups()` 在无 JSON 时整库替换恢复 |
| pi 编排边界 | `assertPiModelRelayOnly` 拒绝 tools/enableTools/autonomous/orchestration；capability / Models / `docs/PI_RUNTIME.md` 标明**模型代调、非自主工具编排**；runtime 暴露 `pi` 边界对象 |
| 真实模型可选验收 | `MOLAN_LIVE_MODEL=1` + Key 才跑 `npm run test:live-model`；默认 SKIP；**未**纳入 `test:audit`；见 `docs/LIVE_MODEL.md` |

## 如何跑

```bash
npm run typecheck
npm run test:regression    # 含 P9 pi/lease 谓词
npm run test:e2e           # 含物理备份恢复 + pi 边界
npm run test:e2e:browser
MOLAN_LEASE_DATABASE_URL=postgres://molan:molan@127.0.0.1:5432/molan_lease \
  npm run test:pg-lease    # 真实 PG；不可达则软跳过 PG 项、仍跑 PGlite
# 可选（会花钱）：
MOLAN_LIVE_MODEL=1 MOLAN_API_KEY=... MOLAN_BASE_URL=... MOLAN_MODEL=gpt-4o-mini \
  npm run test:live-model
npm run test:audit         # regression + e2e + browser + pg-lease（不含 live-model）
```

物理备份路径说明见 `docs/STORAGE_LEASE.md`。

## 实际测试（本机）

- `typecheck` 通过
- `test:regression` → **30/30**
- `test:e2e` → **63/63**
- `test:e2e:browser` → **43/43**
- `test:pg-lease`（真实 Postgres 17 + PGlite）→ **10/10**
- `test:live-model`（无 Key）→ **SKIP**

## 仍受限 / 诚实边界

- **应用内** `DATABASE_URL` / PGlite 仍是内存镜像整表刷盘；跨进程租约已在**独立原生 SQL**上验证，尚未替换整站驱动为原生 Postgres。
- 物理备份是**整库文件**灾难兜底，不是按书的增量物理分区；恢复会影响同库其他书。
- pi **明确不做**自主工具编排（产品边界，不是缺测）。
- 真实模型额度需本机 Key + `MOLAN_LIVE_MODEL=1`；默认 CI 不花费。

## 文档

- `docs/STORAGE_LEASE.md` — SQLite / PG lease / 物理备份
- `docs/PI_RUNTIME.md` — pi 模型代调边界
- `docs/LIVE_MODEL.md` — 可选 live 验收

本阶段 HEAD：`acd26cd`。
