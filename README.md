# 墨兰写作（molan os）

以一本书为中心的写作工作台。主线是：一句话建书 → 大纲入库 → 章节细纲 → 正文 → 审核与去 AI 味。

英文名：**molan os** / **molan**。仓库 slug：`molan-os`。

## 启动

```bash
npm run dev:server
npm run dev:web
```

或 `npm run dev`。页面 http://127.0.0.1:5173 ，接口 http://127.0.0.1:8787 。

## 存储（SQLite / Postgres）

默认 **SQLite**：`data/changjuan.sqlite`（内部文件名保留旧版兼容，产品名已改为墨兰写作），零配置。

可选 Postgres：

| 环境变量 | 行为 |
|---|---|
| （无） | SQLite |
| `DATABASE_URL=postgres://user:pass@host:5432/db` | 连接真实 PostgreSQL（`pg`） |
| `MOLAN_DB=postgres` 或 `pglite`（无 URL；兼容旧名 `CHANGJUAN_DB`） | 嵌入式 PGlite（文件在 `data/changjuan-pglite/`） |

Postgres / PGlite 模式下，内存镜像保持与现有同步 API 兼容，写入会刷到 Postgres 持久层。`GET /api/health` 的 `db.driver` 会显示 `sqlite` / `postgres` / `pglite`。

示例：

```bash
MOLAN_DB=pglite npm run dev:server
# 或
DATABASE_URL=postgres://localhost:5432/molan npm run dev:server
```

## 技能

`skills/*/SKILL.md`，启动扫描入库。「技能」页可重载。

## 书稿文件

`data/books/<bookId>/` 下 Markdown 镜像；网页保存/生成后同步。权威来源仍是数据库。

## 模型与写作运行时

- **local-draft**：内置中文草稿
- **OpenAI 兼容**：模型页配置 Base URL / API Key
- **pi-agent**：已安装 `@earendil-works/pi-agent-core`。设 `MOLAN_AGENT_RUNTIME=pi`（兼容 `CHANGJUAN_AGENT_RUNTIME`）或场景路由 `provider=pi` 启用。会真实构造 `Agent` 跑一轮；无远端密钥时用本地草稿经 Agent 交付。

`GET /api/agent/runtime` 列出能力与当前 db 驱动。

## 服务端批量任务

工作室「批量写」创建 `writing_jobs` 后，**服务端 worker** 每 2.5s（`MOLAN_JOB_INTERVAL_MS`，兼容 `CHANGJUAN_JOB_INTERVAL_MS`）自动 `tick` 推进大纲→细纲→正文，不依赖前端连跑。也可手动 `POST /api/jobs/:id/tick`。`GET /api/jobs/worker` 看 worker 状态。

## 品牌与内部路径

| 对外 | 内部（兼容保留） |
|---|---|
| 墨兰写作 / molan os | 本地目录名可能仍为 `changjuan/` |
| `molan-os` 仓库 | `data/changjuan.sqlite`、`data/changjuan-pglite/` |
| `MOLAN_*` 环境变量 | 仍认 `CHANGJUAN_*` |

## 其它

选区改写、TipTap 稿纸、流式 SSE、章节改名删除、未保存离开提醒等见界面。
