# Rust 重写进度（molan-os）

分支：`rust-rewrite`  
基线（Node/Hono）：`2b2d1bb`  
目标：用 Rust（Axum + rusqlite）**1:1 复刻**现有 Hono API、SQLite schema、技能挂载、chat/stream、generations CAS/abort、jobs lease、出站安全、`data/books` md 同步。前端（Vite/React）保留，就绪后通过 `MOLAN_API_PROXY` 指向 Rust。

## 怎么跑

```bash
# 终端 1：Rust API（默认 127.0.0.1:8788，避免与 Node :8787 冲突）
npm run dev:rust
# 或
cd rust-server && cargo run

# 终端 2：前端指向 Rust
MOLAN_API_PROXY=http://127.0.0.1:8788 npm run dev:web
```

共用同一 SQLite：`data/changjuan.sqlite`（可用 `MOLAN_SQLITE_PATH` 覆盖）。**不要**同时让 Node 与 Rust 写同一库。

环境变量与 Node 对齐：`PORT`、`MOLAN_HOST`、`MOLAN_SQLITE_PATH`、`MOLAN_ROOT`、`MOLAN_SECRET` / `MOLAN_ENCRYPTION_KEY`、`MOLAN_API_KEY`、`MOLAN_ALLOWED_BASE_HOSTS`、`MOLAN_ALLOW_PUBLIC_HTTP_BASE`、`MOLAN_CORS_ORIGINS`。

## 阶段计划

| 阶段 | 内容 | 状态 |
|------|------|------|
| 0 | 分支 + 脚手架 + 文档 | ✅ |
| 1 | health / settings/provider / books CRUD + schema | ✅ |
| 2 | chapters / artifacts 读写 + md sync `data/books` + CAS | ✅ |
| 3 | skills + attachScenes + for-scene / prompt-preview | ✅ |
| 4 | scene-routes + provider test/models refresh + outbound | ✅ |
| 5 | chat / scene-runs / selection-rewrite（含 stream） | ✅ |
| 6 | generations begin / cancel / complete / demote + stream 接线 | ✅ |
| 7 | writing_jobs + lease worker | ✅ |
| 8 | import/export ZIP、bible、hooks、usage、search、progress | ✅ |
| 9 | 浏览器 E2E / regression 对拍 Node | ⬜ |

## API 对拍矩阵

图例：✅ 已实现 · 🟡 部分 · ⬜ stub(501) · — 不做

| 方法 | 路径 | Rust | 备注 |
|------|------|------|------|
| GET | `/api/health` | ✅ | `runtime: rust` + 真实 `jobsWorker` |
| GET | `/api/jobs/worker` | ✅ | |
| GET | `/api/agent/runtime` | ✅ | pi 边界「仅代调」；Rust 暂标 pi unavailable |
| GET | `/api/books` | ✅ | |
| POST | `/api/books` | ✅ | Idempotency-Key |
| GET | `/api/books/:id` | ✅ | 调 md sync |
| PATCH | `/api/books/:id` | ✅ | confirmTrim / 缩章冲突 |
| DELETE | `/api/books/:id` | ✅ | |
| POST | `/api/books/:id/chapters` | ✅ | |
| PATCH/DELETE | `/api/books/:id/chapters/:number` | ✅ | |
| PUT | `/api/books/:id/artifacts` | ✅ | CAS + 对白 `“…”` |
| GET/… | `/api/books/:id/artifacts/revisions*` | ✅ | list/get/diff/restore |
| GET | `/api/books/:id/artifacts/file` | ✅ | |
| GET | `/api/books/:id/export.zip` | ✅ | md 目录打包 |
| GET | `/api/books/:id/chapters/:n/export.zip` | ✅ | |
| GET | `/api/books/:id/chapters/:n/export.md` | ✅ | |
| POST | `/api/books/import` | ✅ | JSON `zipBase64`；validate-then-commit；覆盖=逻辑 JSON + 按书 `.book.phys.sqlite`；失败回滚 |
| GET/POST | `/api/books/:id/jobs` | ✅ | |
| GET/PATCH | `/api/jobs/:id` | ✅ | pause/cancel/running/done |
| POST | `/api/jobs/:id/tick` | ✅ | SQLite lease + in-process lock |
| POST | `/api/jobs/:id/retry` | ✅ | |
| GET | `/api/books/:id/progress` | ✅ | |
| GET | `/api/books/:id/search` | ✅ | |
| GET/POST/PATCH/DELETE | `/api/books/:id/bible*` | ✅ | |
| GET/PATCH | `/api/books/:id/hooks` | ✅ | |
| GET | `/api/books/:id/review-issues` | ✅ | |
| GET | `/api/usage` `/api/usage/summary` `/api/books/:id/usage` | ✅ | |
| GET/PUT | `/api/settings/provider*` | ✅ | |
| GET/PUT | `/api/scene-routes` | ✅ | |
| GET/PATCH/POST | `/api/skills*` | ✅ | |
| POST | `/api/generations/*` | ✅ | |
| POST | `/api/books/:id/chat` (+stream) | ✅ | |
| POST | `/api/books/:id/scene-runs` (+stream) | ✅ | |
| POST | `/api/books/:id/selection-rewrite` (+stream) | ✅ | |
| GET | `/api/books/:id/messages` | ✅ | |
| POST | `/api/books/auto-setup` | ⬜ | 显式 501（避免被 `:id` 吃掉变 405） |
| POST | `/api/books/:id/auto-setup` | ⬜ | 显式 501 |
| 其他未列 | catch-all | ⬜ | 501 |

## 本轮实现要点（阶段 7–8：jobs / 导入导出 / 高流量）

- **writing_jobs**：创建 / 列表 / 查询 / `PATCH status`（paused/running/cancelled/done）/ retry / tick。
- **SQLite 租约**：`lease_owner` / `lease_until` 谓词与 Node `SQLITE_ACQUIRE_SQL` 一致；HTTP tick 与后台 worker 共用 in-process Set + DB lease。
- **Worker**：启动时 `start_job_worker`（默认每 2.5s）；health / `/api/jobs/worker` 返回真实状态。
- **tick 阶段机**：outline → chapter_outline → chapter_body → memory →（可选 review）→ 下一章 / done；取消中途写候选（`job_id` → execute_scene）。
- **ZIP 导出**：全书 / 单章 zip、章 md；基于 `data/books` sync。
- **ZIP 导入**：`zipBase64` JSON；解压限额 / zip-slip / symlink 拒绝；**先校验预读章节文件再写库**；覆盖前逻辑 JSON + 按书物理 SQLite；失败逻辑回滚；启动 `recover_interrupted_imports`。
- **高流量**：progress / search / bible CRUD / hooks / usage / review-issues / agent runtime。

冒烟（临时库 :8798/:8797）：health worker running → 建书 → progress/search/bible → job pause/resume/tick/cancel/retry → export.zip → import new/overwrite/skip → `MOLAN_IMPORT_FAIL_AFTER_WIPE=1` 覆盖失败回滚保留原大纲。

## Schema 对拍

Rust `rust-server/src/schema.rs` 镜像 Node `sqliteSchema()` + `migrateSqlite()`（含 `writing_jobs` lease 列、`thinking_intensity`、`source_revision_id`、`generations`、`bible_cards`、`hook_marks`、`api_usage` 等）。默认驱动仍为 SQLite。

## 前端切换

```bash
MOLAN_API_PROXY=http://127.0.0.1:8788 npm run dev:web
```

## 刻意保留 / 剩余缺口

- 产品默认仍是 **SQLite**；Rust 不引入 PG。
- **pi** 不做自主编排（`/api/agent/runtime` 标明 model-relay；Rust 暂未链 npm pi 包）。
- 导入暂只接 **JSON zipBase64**（multipart 未接）。
- **auto-setup** 仍 501。
- **异步记忆抽取 / waitMemoryExtract** 未对拍（job memory 阶段改为现场 `memory_extract`）。
- 阶段 9：浏览器 E2E / regression 对拍 Node 尚未跑。
- 未移植接口返回 **501** + 中文说明，避免静默假成功。
