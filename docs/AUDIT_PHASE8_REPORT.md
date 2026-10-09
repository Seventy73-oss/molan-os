# molan-os 审查修复第八阶段报告

基线续作：`b36409f`（阶段 7 之后）  
本阶段提交：代码 `50a9235`；文档链至 HEAD `7d6701d`  
测试：`npm run typecheck` 通过；`npm run test:regression` → **26/26**；`npm run test:e2e` → **53/53**；`npm run test:e2e:browser` → **43/43**。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| 已 `completed` 后再点停止 | 阶段 7：cancel 幂等不 demote，但客户端只提示「已停止本次对话」，易误解为已撤回；也无便捷还原 | `cancelGeneration` 对已完成/失败返回 `alreadyTerminal`、`accepted`、`previousRevisionId`、`note`，**绝不** demote、不改 `agent` 来源；工作室若竞态 abort 撞上已完成：刷新书稿并提示「结果已保留；停止不会撤回」，toast 提供「还原上一版」 |
| 版本历史可选还原上一版 | 仅逐条「还原」，当前稿不便退回 | 历史面板在有上一修订时显示「还原上一版」（仍走原 restore API，生成新修订、不删历史） |
| `peekPreviousRevisionId` | 无廉价查询上一修订 | 导出辅助函数，供 cancel 响应与测试使用 |
| E2E | 未覆盖完成态停止与历史还原 | API：完成后再 cancel 不 demote / 给出 previous / 手动还原；浏览器：工具→版本→还原上一版；完成后 cancel 保持 accepted |

## 数据迁移与兼容性

- 无新表结构；cancel 响应仅增加可选字段，旧客户端可忽略。
- 书稿 md 目录结构不变；SQLite 默认不变。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 53/53（含完成后再停止不 demote / 手动还原）
npm run test:e2e:browser  # 43/43（含版本历史还原上一版 + 完成后再 cancel）
# 或
npm run test:audit
```

## 仍受限 / 未验证

- **真 Postgres 集群 / 多副本 lease**：仍未接；默认拒开非 SQLite worker ≠ 已实现跨进程锁。本阶段**不宣称**已具备集群租约。
- **覆盖导入**仍是逻辑 JSON 快照，不是整库物理备份。
- **pi** 仍为代调模型，**不是**自主工具编排。
- 浏览器 E2E 仍未盖真实远端模型额度与极慢 token 级 UI；完成态「停止」竞态主要靠 API 断言 + abort 路径提示，未在 UI 上强制复现「写完瞬间再点停止」的完整动画竞态。

## 可复现回归

```bash
npm run test:audit   # regression + e2e + e2e:browser
```

本阶段 HEAD：`7d6701d`。
