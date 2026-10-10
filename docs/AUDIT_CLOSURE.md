# molan-os 审查收口（AUDIT CLOSURE）

对照审查报告与阶段 1–12 修复，**可自动化验收的主路径已闭环**。  
产品默认与刻意边界如下——不是未做完的 bug，而是选择。

## 已落地（验收覆盖）

| 主题 | 状态 |
|---|---|
| 保稿 / 会话 / generation 幂等 / CAS | 阶段 1–2；regression + e2e |
| 任务暂停 / 取消；审核记忆绑定 | 阶段 2 |
| 出站安全；ZIP 导入校验后提交 | 阶段 3 |
| 流式 Abort / cancel；覆盖导入逻辑回滚 | 阶段 3–5 |
| Playwright 书库→工作室；选区气泡；流式停止 | 阶段 4–8 |
| 取消 demote；完成后停止不 demote + 还原上一版 | 阶段 7–8 |
| SQLite 租约；Postgres 租约 harness | 阶段 9–10 |
| 按书物理备份；遗留整库转按书或拒绝 | 阶段 10–11 |
| 可选原生 PG；SQLite→PG 迁移（含 `--sync` 幂等） | 阶段 10–12 |
| 整库 phys 脚本路径默认拒绝 + quarantine CLI | 阶段 12 |
| pi = 模型代调（拒 tools/自主编排） | 阶段 9+；见 `docs/PI_RUNTIME.md` |
| 真实模型 = opt-in（`MOLAN_LIVE_MODEL=1`） | 阶段 9+；见 `docs/LIVE_MODEL.md`；**不进** `test:audit` |

日常：`npm run test:audit`（regression + e2e + browser + pg-lease）。

## 产品选择（刻意保留）

1. **默认 SQLite** — 单机写库；原生 PG 需 `MOLAN_NATIVE_PG=1` + 迁移。
2. **pi 非自主编排** — 只代调模型；要工具规划需另立项。
3. **live-model 不进 CI** — 避免烧 Key / 外网抖动；本机自测见 `docs/LIVE_MODEL.md`。
4. **迁移单向 upsert、无 prune** — `--sync` 可重复；PG 多出行不自动删。
5. **整库 phys 弃用** — 仅 `MOLAN_ALLOW_WHOLE_DB_PHYS_RESTORE=1`；平时用按书 dump / `quarantine:legacy-phys`。
6. **无静默本地降级** — 缺 Key / 非法 Base URL 硬错误。

## Markdown / 数据布局

- `data/books/` 导出布局不变；迁移不搬 md。
- 逻辑恢复：`data/import-recovery/<id>.json`
- 按书物理：`data/import-recovery/<id>.book.phys.sqlite`

## 阶段报告索引

- `docs/AUDIT_PHASE_REPORT.md` … `docs/AUDIT_PHASE12_REPORT.md`
- 存储：`docs/STORAGE_LEASE.md`
- pi / live：`docs/PI_RUNTIME.md`、`docs/LIVE_MODEL.md`

## 诚实遗留（非阻塞）

- 无自动双向 SQLite↔PG 同步；无自动 prune。
- 整库恢复仍存在于显式灾难开关，不推荐。
- 原生 PG 经 worker 同步桥；非「零配置多副本水平扩展」。
- Playwright 未覆盖全部真实云模型额度路径（by design）。

审查主线到阶段 12 **收口**。后续增强按产品立项，不再算审计缺口。
