# molan-os 审查修复第四阶段报告

基线续作：`f0769ff`（阶段 3 之后）  
测试：`npm run typecheck` 通过；`npm run test:regression` → **26/26**；`npm run test:e2e` → **25/25**；`npm run test:e2e:browser` → **10/10**。  
默认存储仍为 SQLite；Markdown 导出布局未改；正式生成仍无服务端静默本地降级。

## 本阶段改了什么

| 项 | 故障 / 缺口 | 改动 |
|---|---|---|
| 浏览器 UI E2E | 阶段 3 仅 API/引擎级 | `server/scripts/e2e-browser.mts`（Playwright Chromium）：书库 → 创建新书 → 工作室 → 技能/模型 → 回书库；`MOLAN_CORS_ORIGINS` + 动态端口；`npm run test:e2e:browser` |
| Vite 联调 | 代理写死 8787/5173 | `MOLAN_API_PROXY` / `MOLAN_WEB_PORT` 可配，便于并行 E2E |
| 覆盖导入崩溃窗口 | wipe 与 restore 之间杀进程可能丢书 | 覆盖前落盘 `data/import-recovery/<bookId>.json`（tmp+rename）；成功/回滚成功后删除；启动 `recoverInterruptedImports()`；失败且内存回滚失败时保留文件并提示人工恢复 |
| Postgres 多进程租约 | 镜像刷盘无法跨进程互斥 | `assertJobWorkerStoragePolicy`：非 SQLite **默认拒绝**启动任务 worker；仅 `MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1` 且单进程可强制开启；`docs/STORAGE_LEASE.md` 更新 |

## 数据迁移与兼容性

- 无新表结构变更。
- 新增目录 `data/import-recovery/`（已 `.gitignore`），仅覆盖导入短暂使用。
- 书稿 md 目录结构不变。
- SQLite 默认与阶段 3 一致。

## 实际测试

```bash
npm run typecheck
npm run test:regression   # 26/26
npm run test:e2e          # 25/25（含落盘恢复、PG worker 开关）
npm run test:e2e:browser  # 10/10 Playwright
# 或
npm run test:audit
```

浏览器覆盖：书库页、UI 建书（经 CORS 信任源）、工作室书名与对话框、技能页、模型页、回书库、API 清理测试书。

## 仍受限 / 未验证

- **真 Postgres 集群 / 多副本 lease**：仍未接；代码层拒绝默认多 worker，不等于已实现跨进程锁。
- **覆盖导入**仍是逻辑快照 + 落盘 JSON，不是整库物理备份；磁盘满/JSON 损坏时需人工核对 `data/import-recovery/`。
- **浏览器 E2E**未覆盖流式对话全文、选区改写气泡、真实模型额度。
- **pi** 仍为代调模型，不是自主工具编排。

## 可复现回归

```bash
npm run test:audit   # regression + e2e + e2e:browser
```
