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
| 8b | auto-setup / multipart import / memory extract / pi 边界 | ✅ |
| 9 | 浏览器 E2E / Studio 基础路径对拍 | ✅ |

## API 对拍矩阵

图例：✅ 已实现 · 🟡 部分 · ⬜ stub(501) · — 不做

| 方法 | 路径 | Rust | 备注 |
|------|------|------|------|
| GET | `/api/health` | ✅ | `runtime: rust` + 真实 `jobsWorker` |
| GET | `/api/jobs/worker` | ✅ | |
| GET | `/api/agent/runtime` | ✅ | pi 边界「仅代调」；Rust 原生 PiRelay（openai 若已配否则 local）；拒 tools |
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
| POST | `/api/books/import` | ✅ | JSON `zipBase64` **或 multipart `file`**；validate-then-commit；覆盖=逻辑 JSON + 按书 `.book.phys.sqlite`；失败回滚 |
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
| POST | `/api/books/auto-setup` | ✅ | brief → book_setup → 建书+章目+档案 |
| POST | `/api/books/:id/auto-setup` | ✅ | 指定 id；已存在 409 |
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

## 本轮实现要点（阶段 8b：缺口收口）

- **auto-setup**：`POST /api/books/auto-setup` 与 `POST /api/books/:id/auto-setup`；`book_setup` 场景 + 用户包挂载；解析书名/题材/简介/文风/章目；落档案修订。
- **multipart 导入**：与前端 `FormData(file, conflict, title)` 对齐；仍支持 JSON `zipBase64`。
- **记忆抽取**：`schedule_memory_extract` / `wait_memory_extract` 对拍 Node；正文保存后异步抽取；job `memory` 阶段等待（超时继续）；`sourceRevisionId` 绑定正文修订。
- **pi 边界**：Rust 原生 `PiRelayAdapter`（有 Key 走 openai，否则 local-draft）；`modelUsed` 前缀 `pi-agent/`；拒 `tools` / `enableTools` / `autonomous` / `orchestration`；`/api/agent/runtime` 标 available + model-relay。

冒烟（:8799 临时库）：health → agent/runtime(pi available) → auto-setup → chapter_body 后 chapter_memory 异步落盘 → pi+enableTools 拒绝 / pi 正常代调 → multipart import → 空 brief 400。

## 本轮实现要点（阶段 9：浏览器 E2E / Studio 基础路径）

- **跑法**：`npm run test:e2e:browser:rust`（或 `MOLAN_E2E_RUNTIME=rust npm run test:e2e:browser`）。脚本拉起 `rust-server/target/debug/molan-api` + Vite（`MOLAN_API_PROXY`→临时端口），与 Node 套件同一套 Playwright 断言。
- **流式预延迟**：Rust `chat` 对齐 Node `optionalStreamPreDelay`（`MOLAN_STREAM_PRE_DELAY_MS`），中途「停止」可在写入前取消。
- **Studio 基础路径**（实测）：书库→新书→工作室→选区四动作+「对助手说」→中途停止保大纲→流式写大纲→版本还原→完成后再取消不 demote→技能/模型→回书库。

### Node vs Rust 对拍（阶段 9）

| 能力 | Node | Rust | 说明 |
|------|------|------|------|
| 书库 CRUD / 进工作室 | ✅ | ✅ | 浏览器 E2E |
| TipTap 载入 / 手工保稿 CAS | ✅ | ✅ | PUT artifacts + revisionId |
| 选区改写四动作 + 对助手说 | ✅ | ✅ | selection-rewrite + stream |
| chat/stream 写大纲（local-draft） | ✅ | ✅ | SSE token/done 形状对齐 |
| 中途停止 + demote / 完成后不 demote | ✅ | ✅ | generations cancel |
| 版本历史还原上一版 | ✅ | ✅ | revisions/restore |
| 技能挂载 / for-scene | ✅ | ✅ | 用户蒸馏包 primary |
| 模型页 provider / routes | ✅ | ✅ | 无 Key 时 models 空列表+error 文案 |
| 任务租约 / ZIP 导入导出 | ✅ | ✅ | API 冒烟（非本轮浏览器） |
| `npm run test:audit` 全套对拍 | ✅ | 🟡 | regression/e2e/pg-lease 仍绑 Node；浏览器已有 Rust 入口 |
| 真 Postgres / 迁移工具 | ✅（可选） | — | 刻意不做 |
| pi 自主编排 | — | — | 两边都只代调 |

## 刻意保留 / 剩余缺口

- 产品默认仍是 **SQLite**；Rust **不引入 PG**（Node 侧可选原生 PG 仍在 main）。
- **pi** 不做自主编排；Rust **不链接** npm `@earendil-works/pi-agent-core`，用等价模型代调路径（边界与文案对拍）。
- **regression / API e2e / pg-lease** 脚本仍默认打 Node；尚未把整份 `test:audit` 切到 Rust 双跑。
- chat/stream 在 local-draft 下仍是「先完整 `chat()` 再 chunk 吐字」（与 Node 同构）；真流式只在 OpenAI 兼容适配器路径。
- catch-all 未列接口仍 **501** + 中文说明，避免静默假成功。
- Node 专有：SQLite→PG 迁移工具、PGlite worker 开关等 **不在** Rust 范围。

## 出站自动重试（与 Node 对齐）

`secure_fetch` 支持 `retries` / `retry_backoff_ms`：模型调用与 provider 探测默认 `MODEL_FETCH_RETRIES=2`，网络与 HTTP 4xx/5xx（含 400/401/403/429）有限重试；取消/Abort 不重试，失败不降本地。



## G2 StoryLedger

定稿指针 / 记忆提案 / epoch·幂等 / 替换失效已落地，见 `docs/AUDIT_PHASE_G2_STORY.md`。
