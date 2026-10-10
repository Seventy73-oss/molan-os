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
| 4 | scene-routes + provider test/models refresh + outbound | ⬜ |
| 5 | chat / scene-runs / selection-rewrite（含 stream） | ⬜ |
| 6 | generations begin / cancel / complete / demote（服务已齐；stream 接线待阶段 5） | 🟡 |
| 7 | writing_jobs + lease worker | ⬜ |
| 8 | import/export ZIP、bible、hooks、usage、search | ⬜ |
| 9 | 浏览器 E2E / regression 对拍 Node | ⬜ |

## API 对拍矩阵

图例：✅ 已实现 · 🟡 部分 · ⬜ stub(501) · — 不做

| 方法 | 路径 | Rust | 备注 |
|------|------|------|------|
| GET | `/api/health` | ✅ | 含 `runtime: rust`；worker 尚未移植 |
| GET | `/api/books` | ✅ | |
| POST | `/api/books` | ✅ | Idempotency-Key |
| GET | `/api/books/:id` | ✅ | 调 md sync |
| PATCH | `/api/books/:id` | ✅ | confirmTrim / 缩章冲突 |
| DELETE | `/api/books/:id` | ✅ | 删库行 + 尽力删 `data/books/:id` |
| POST | `/api/books/:id/chapters` | ✅ | 加章 + sync |
| PATCH | `/api/books/:id/chapters/:number` | ✅ | 重命名 + sync |
| DELETE | `/api/books/:id/chapters/:number` | ✅ | 删章重编号 + wipe + sync |
| PUT | `/api/books/:id/artifacts` | ✅ | `saveRevision` + `expectedRevisionId` CAS；正文对白 `“…”` |
| GET | `/api/books/:id/artifacts/revisions` | ✅ | |
| GET | `/api/books/:id/artifacts/revisions/:revId` | ✅ | |
| GET | `/api/books/:id/artifacts/revisions/:revId/diff` | ✅ | 行级 hunk |
| POST | `/api/books/:id/artifacts/revisions/:revId/restore` | ✅ | |
| GET | `/api/settings/provider` | ✅ | 不回传明文 Key；enc:v1 兼容 |
| PUT | `/api/settings/provider` | ✅ | Base URL 白名单 |
| GET | `/api/settings/provider/models` | ✅ | 读缓存；未实现 refresh |
| POST | `/api/settings/provider/test` | ⬜ | |
| POST | `/api/settings/provider/models/refresh` | ⬜ | |
| GET/PUT | `/api/scene-routes` | ⬜ | |
| GET | `/api/skills` | ✅ | 启动时 `reloadSkills`；用户包 `attachScenes` |
| POST | `/api/skills/reload` | ✅ | |
| PATCH | `/api/skills/:id` | ✅ | enabled |
| GET | `/api/skills/for-scene` | ✅ | 阶段矩阵强制挂用户包 |
| GET | `/api/skills/:id/prompt-preview` | ✅ | 加载 `skills/<id>/pack/` |
| POST | `/api/generations/begin` | ✅ | 幂等 stub（供后续 stream 接线） |
| GET | `/api/generations/:id` | ✅ | |
| POST | `/api/generations/:id/cancel` | ✅ | demote / completed 不静默撤回 |
| POST | `/api/books/:id/chat` (+stream) | ⬜ | |
| POST | `/api/books/:id/scene-runs` (+stream) | ⬜ | |
| POST | `/api/books/:id/selection-rewrite` (+stream) | ⬜ | |
| Jobs / worker / lease | `/api/jobs*` | ⬜ | |
| Import/export / bible / hooks / usage / search | 多条 | ⬜ | catch-all 501 |
| GET | `/api/agent/runtime` | ⬜ | pi 边界保持「仅代调」 |

## 本轮实现要点（阶段 2–3 + generations 桩）

- **CAS**：`expectedRevisionId` 不匹配 → 409；可选后续 AI 路径用 `onConflict=candidate`。
- **md sync**：DB 胜出，落盘 `data/books/:id/`（`00-档案.md` / `00-全书大纲.md` / `NN-章名/{细纲,正文,审核,记忆}.md`）。
- **技能矩阵**：与 Node 一致——大纲挂 volume-arcs / structure-skeleton / novel-craft；正文挂 humanize + style-corpus；chat 挂 novel-craft / opening-cards；大纲/chat **不**挂 humanize。
- **generations**：`begin` / `get` / `cancel` / `complete` / `demoteCancelledResultRevision` 已移植；chat/stream 尚未接线。

## Schema 对拍

Rust `rust-server/src/schema.rs` 镜像 Node `server/src/db/schema.ts` 的 `sqliteSchema()` + `migrateSqlite()`（含 `writing_jobs` lease 列、`thinking_intensity`、`source_revision_id`、`generations`、`bible_cards` 等）。默认驱动仍为 SQLite；Postgres/PGlite 原生驱动后续再议。

## 前端切换

`vite.config.ts` 已支持 `MOLAN_API_PROXY`（默认 `http://127.0.0.1:8787`）。指向 Rust：

```bash
MOLAN_API_PROXY=http://127.0.0.1:8788 npm run dev:web
```

Node 后端继续用 `npm run dev:server`（:8787）。

## 冒烟（本轮）

临时库 + `:8799`：建书 → 大纲 CAS → 加/改/删章 → md 落盘 → 正文对白规范化 → `for-scene` / prompt-preview → generations begin/cancel/demote/restore。全部通过。

## 刻意保留

- 产品默认仍是 **SQLite**；Rust 不引入 PG。
- **pi** 不做自主编排（与 Node 边界一致）。
- 未移植接口返回 **501** + 中文说明，避免静默假成功。
