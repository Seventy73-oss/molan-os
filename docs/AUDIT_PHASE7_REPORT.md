# molan-os 审查修复第七阶段报告

基线续作：`acda3c4`（阶段 6 之后）  
本阶段提交：代码 `eaf249d`；文档链至 HEAD `3379154`  
测试：`npm run typecheck` 通过；`npm run test:regression` → **26/26**；`npm run test:e2e` → **44/44**；`npm run test:e2e:browser` → **36/36**。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| 取消前已落盘的修订 | 阶段 6：abort 若发生在 `saveRevision` 之后，当前稿可能留下误写入内容，仅 status=cancelled | `linkGenerationResultRevision` 在保存时挂上 `result_revision_id`；`cancelGeneration` / 保存后取消竞态调用 `demoteCancelledResultRevision`：当前稿退回上一修订，误写入标 `source=agent_cancelled` 留在历史；已取消后再保存走候选（`asCandidate`）不设当前 |
| 版本历史可读 | 误写入与正常 agent 修订难区分 | 历史列表将 `agent_cancelled` 显示为「已取消写入 · 可还原」；仍可用原有「还原」生成新修订 |
| 工作室提示 | 停止后只说「已停止本次对话」 | 若 cancel 返回 `revert.demoted`（或 generation.result.cancelRevert），刷新书稿并提示已退回上一版、可在版本历史查看/还原 |
| 气泡「对助手说…」 | 浏览器 E2E 未盖自定义指令 | 点「对助手说…」→ 填指令 →「应用到选区」；断言 selection-rewrite 入参含自定义指令且正文按 local-draft 变冷/去套话；local-draft 对「冷一点 / 别解释动机」有明确规则 |

## 数据迁移与兼容性

- 无新表结构；沿用 `artifact_revisions.source` 写入 `agent_cancelled`。
- `generations.result_json` 在 demote 时可带 `cancelRevert` 说明，供客户端提示。
- 书稿 md 目录结构不变；SQLite 默认不变。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 44/44（含取消后 demote / agent_cancelled / 候选不覆盖）
npm run test:e2e:browser  # 36/36（含「对助手说」自定义指令）
# 或
npm run test:audit
```

## 仍受限 / 未验证

- **真 Postgres 集群 / 多副本 lease**：仍未接；默认拒开非 SQLite worker ≠ 已实现跨进程锁。本阶段**不宣称**已具备集群租约。
- **覆盖导入**仍是逻辑 JSON 快照，不是整库物理备份。
- **pi** 仍为代调模型，**不是**自主工具编排。
- 若 generation 已 `completed` 成功落盘后用户再点停止：cancel 对已完成记录仍为幂等、**不会**自动 demote（视为已接受结果）；退回依赖版本历史手动还原。
- 浏览器 E2E 仍未盖真实远端模型额度与极慢 token 级 UI。

## 可复现回归

```bash
npm run test:audit   # regression + e2e + e2e:browser
```

本阶段 HEAD：`3379154`。
