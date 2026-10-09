# molan-os 审查修复第六阶段报告

基线续作：`ef886f9`（阶段 5 之后）  
本阶段提交：代码 `7e359e5`；文档链至 HEAD `eb0f2ab`  
测试：`npm run typecheck` 通过；`npm run test:regression` → **26/26**；`npm run test:e2e` → **36/36**；`npm run test:e2e:browser` → **32/32**。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| 选区气泡动作矩阵 | 阶段 5 只盖「改写」 | 浏览器 E2E：`改写` / `续写` / `润色` / `加强对白` 均点气泡 → selection-rewrite 200 → 正文按 local-draft 规则变化 |
| 中途 Abort / 取消 | 停止只 abort 拉流，服务端仍可能写稿；迟到 `completed` 可盖掉 `cancelled` | 客户端「停止」顺带 `POST /api/generations/:id/cancel`；`chat`/`executeScene` 在保存前检查 signal + generation 取消；Abort 错误不再被 chat 吞成普通回复；`completeGeneration` 拒绝把已取消记录复活为 completed；测试用 `MOLAN_STREAM_PRE_DELAY_MS` 拉开取消窗口 |
| API E2E 中途取消 | 无「取消后不覆盖当前大纲」断言 | 预置大纲 → delay 内 cancel+abort → 断言 Abort、大纲不变、status=cancelled、迟到 completed 无效 |
| 浏览器中途停止 | 无点停覆盖 | 预置 `PHASE6_BROWSER_SEED` 大纲 → 发「写全书大纲」→ 点「停止」→ 断言大纲仍含种子且出现「已停止本次对话」 |

## 数据迁移与兼容性

- 无新表结构变更。
- `MOLAN_STREAM_PRE_DELAY_MS` 仅为测试/排障可选预延迟（默认 0）；生产勿设。
- 书稿 md 目录结构不变；SQLite 默认不变。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 36/36（含中途取消不覆盖 + 迟到 completed 不复活）
npm run test:e2e:browser  # 32/32（气泡四动作 + 中途停止 + 流式大纲）
# 或
npm run test:audit
```

## 仍受限 / 未验证

- **真 Postgres 集群 / 多副本 lease**：仍未接；默认拒开非 SQLite worker ≠ 已实现跨进程锁。
- **覆盖导入**仍是逻辑 JSON 快照，不是整库物理备份。
- **浏览器 E2E**未盖真实远端模型额度、气泡「缩短 / 对助手说…」自定义指令、极慢真实流式 token 级 UI。
- **中途取消窗口**依赖取消发生在保存之前（测试用预延迟）；若模型在 abort 前已落盘，已写入修订不会自动回滚（status 仍可标 cancelled，但稿面需人工处理）。
- **pi** 仍为代调模型，**不是**自主工具编排。

## 可复现回归

```bash
npm run test:audit   # regression + e2e + e2e:browser
```

本阶段 HEAD：`eb0f2ab`。
