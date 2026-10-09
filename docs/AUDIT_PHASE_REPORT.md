# molan-os 审查修复阶段报告

基线：`313cc669812b2ec246c9ef1d0611fee8d8887639`  
测试：`npm run test:regression` → **26/26 通过**；`npm run typecheck` 通过。  
默认存储仍为 SQLite；数据目录与 Markdown 导出布局保持兼容。

## 第一阶段：止损

| 项 | 故障 | 改动 |
|---|---|---|
| T02-A | 慢保存回填覆盖新输入 | `Studio.persist` 用 session/epoch：用户续写时只更新保存基线，不回填旧正文；切稿 bump session |
| T03 | 流式失败盲目重发非流式 | 取消自动 retry；`generationId` + `generations` 表；断开后先查状态 |
| T04 | 「不要写正文」等误写稿 | `routeMessage` 否定/评价/怎么写 → null；只有明确写命令才进场景 |
| T07 | 无认证 / CORS≠鉴权 | `MOLAN_ACCESS_TOKEN`；写操作校验 Origin/Host；`0.0.0.0` 无 Token 拒绝启动 |
| T08 | 出站检查不完整 | `outbound.secureFetch` 统一正式生成/测连/列模型；HTTPS+Key；`::ffff:c0a8:101` 私网识别；密钥材料 fail-closed |
| T09 | ZIP slip / 标题后缀 / 覆盖 | `relative_to` 防穿越；配额；先预读再写库；覆盖前取消旧任务；同名导入保留「（导入 …）」后缀 |

## 第二阶段：核心一致性

| 项 | 改动 |
|---|---|
| T01 | Postgres/PGlite 标实验性；persist 队列 `.catch` 保活；flush 失败对非 SQLite 返回错误 |
| T02-B | `expectedRevisionId` CAS → 409；稳定 `chapterId`；`asCandidate` 迟到结果不设当前稿 |
| T02-C | 选区改写前比对原文，变化则提示不套用 |
| T05 | `source_revision_id`；记忆按期望 revision 排队，旧结果不覆盖新 |
| T06 | `paused`/`cancelled` 语义；阶段结束后检查 lease；取消不再推进 |
| T10（部分） | 生成幂等与流式失败恢复路径统一；完整上下游 Abort 仍有限 |

## 数据迁移

- `artifact_revisions.source_revision_id`（ADD COLUMN，不删历史）
- 表 `generations`
- 尝试 `UNIQUE(artifact_id, revision)`（已有重复则跳过，不删修订）

## 未验证 / 仍受限

- 浏览器 E2E 慢保存/并发标签页（有单元级 CAS + 前端 epoch 逻辑）
- 多进程 Postgres lease（仍限单 worker 实验模式）
- 真实模型额度 / DNS rebinding 实网
- 覆盖导入「整库事务快照恢复」未做全量物理备份，已做预读校验 + 取消旧任务
- pi 仍为 faux 交付，未宣称为自主工具编排

## 回归用例

```bash
npm run test:regression
```

覆盖：意图路由、IPv6/HTTPS、局域网 Token、CAS/候选稿、generation 幂等、任务暂停取消、ZIP slip、同名导入后缀、persist 队列。

## 第三阶段（续）

见 [`AUDIT_PHASE3_REPORT.md`](./AUDIT_PHASE3_REPORT.md)：AbortSignal 全链路、覆盖导入快照回滚、SQLite 任务租约、API E2E（18/18）。
