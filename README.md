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


## 安全（本机默认）

接口默认只监听 **127.0.0.1**（可用 `MOLAN_HOST=0.0.0.0` 开局域网）。前端 Vite 默认也只绑 **127.0.0.1**（可用 `MOLAN_WEB_HOST=0.0.0.0` 开局域网预览），避免局域网经 `/api` 反代绕开本机 API 绑定。CORS 仅允许本地 Vite 源（`127.0.0.1` / `localhost` 的 5173/5174；额外源用 `MOLAN_CORS_ORIGINS`）。

| 环境变量 | 作用 |
|---|---|
| `MOLAN_HOST` / `HOST` | API 绑定地址，默认 `127.0.0.1` |
| `MOLAN_WEB_HOST` | Vite 绑定地址，默认 `127.0.0.1` |
| `MOLAN_CORS_ORIGINS` | 额外允许的 Origin，逗号分隔 |
| `MOLAN_API_KEY` | 运行时 API Key（优先于库内密钥；勿提交进仓库） |
| `OPENAI_API_KEY` | 同上兼容名 |
| `MOLAN_SECRET` / `MOLAN_ENCRYPTION_KEY` | 库内密钥加密用；不设则自动生成 `data/.molan-secret` |
| `MOLAN_ALLOWED_BASE_HOSTS` | 额外允许的 Base URL 主机名 |
| `MOLAN_ALLOW_LOCAL_LLM` | `1` 时允许本机/内网 LLM（仍建议把主机写入白名单） |

库内 API Key 使用 AES-256-GCM 加密存储；`GET /api/settings/provider` **永不返回完整密钥**，只给尾号提示。**环境变量密钥与已保存密钥**在调用时都要求 Base URL 在白名单内，禁止把密钥发到任意地址或内网/元数据 IP（SSRF 防护）。OpenAI/pi 调用失败会直接报错，不再静默回退本地草稿。错误信息会脱敏 `Authorization` / `sk-…` 等。

## 其它

选区改写、TipTap 稿纸、流式 SSE、章节改名删除、未保存离开提醒等见界面。


## 审查回归

```bash
npm run test:regression
npm run test:e2e
npm run test:audit
```
