# molan-os 审查修复第五阶段报告

基线续作：`775df28`（阶段 4 之后）  
本阶段提交：见 git HEAD（本报告随提交写入）  
测试：`npm run typecheck` 通过；`npm run test:regression` → **26/26**；`npm run test:e2e` → **32/32**；`npm run test:e2e:browser` → **19/19**。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| 浏览器流式对话写作 | 阶段 4 未盖流式 chat 写稿 | `e2e-browser.mts`：预置正文后发「写全书大纲」，断言 `chat/stream` 200、状态提示、落盘大纲 / toast「已写入」；全程 **local-draft**，不花真实模型额度 |
| 浏览器选区改写气泡 | 未盖 TipTap 选区气泡 | 预置含「不禁/宛如」正文 → Control+A → `.sel-bubble` →「改写」→ 断言 stream/API 200 且正文可见变化（句子重排 / 去套话） |
| 导入恢复小加固 | 损坏 JSON / 孤儿 tmp 反复失败 | 写快照尽量 `fsync`；读时校验 schema+bookId；损坏移入 `data/import-recovery/corrupt/`；启动清理 `.*.tmp`；测试覆盖隔离与清理 |
| Postgres 租约拒开断言 | 仅测 env 开关 | 抽出纯函数 `jobWorkerAllowedForDriver`；E2E 断言 postgres/pglite **默认拒开**，显式 flag 才允许；**不宣称**已实现集群 lease |
| 文档 | 恢复与租约说明 | `docs/STORAGE_LEASE.md` 补充 fsync / corrupt / 仍是逻辑快照 |

## 数据迁移与兼容性

- 无新表结构变更。
- `data/import-recovery/corrupt/` 为新增子目录（损坏快照隔离）；仍在既有 `.gitignore` 的 `data/` 范围。
- 书稿 md 目录结构不变；SQLite 默认不变。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 32/32（含损坏隔离、PG 驱动拒开）
npm run test:e2e:browser  # 19/19（含选区改写 + 流式大纲）
# 或
npm run test:audit
```

浏览器新增覆盖：正文载入 TipTap、选区气泡、local-draft 改写写回、流式对话状态与大纲写入。

## 仍受限 / 未验证

- **真 Postgres 集群 / 多副本 lease**：仍未接；代码层默认拒绝非 SQLite worker，**不等于**已实现跨进程锁。勿将 opt-in 开关用于多副本。
- **覆盖导入**仍是逻辑 JSON 快照 + 尽量 fsync，不是整库物理备份；磁盘满 / 极端损坏仍需人工核对 `data/import-recovery/`（含 `corrupt/`）。
- **浏览器 E2E**未盖真实远端模型额度、长正文流式逐 token UI、选区「续写/润色/对白」全按钮矩阵、中途 Abort 点停。
- **pi** 仍为代调模型，**不是**自主工具编排。

## 可复现回归

```bash
npm run test:audit   # regression + e2e + e2e:browser
```
