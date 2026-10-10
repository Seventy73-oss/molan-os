# G4：写作体验 · 自包含导出恢复 · 发布检查

基线计划：开源借鉴路线「G4：写作体验、导出恢复和发布检查」。

## 已落地（rust-rewrite 为主，main Node 对等）

1. **自包含故事包 `molan.story-pack/v1`**
   - 布局：`manifest.json` + `manuscript/` + `story/` + `provenance/` + `views/`
   - 含正文修订、定稿指针、事实、提案、伏笔事件、知识事件、设定卡修订与审批溯源
   - 默认不含 API Key / 会话；`includeSecrets=1` 才含作者秘密
   - API：`GET /api/books/:id/story-pack.zip`、`POST /api/books/import-story-pack`

2. **validate-then-commit 导入（永远新书）**
   - 校验 format / 版本 / 文件 hash / 路径 / 跨书 `book_id` / 定稿正文自包含引用
   - 非法 ZIP（穿越、炸弹）在 validate/解压阶段拒绝，现有书不变（T21）
   - 导入生成新 ID 映射，恢复定稿与事实关系（T22）

3. **上下文面板打磨**
   - 工具抽屉「上下文」：入选/排除清单、预算估算（tokenizer=unknown）、缺失提示
   - `context-preview` 增加 `budgetEstimate`

4. **发布检查**
   - `GET /api/books/:id/story/publish-check?chapterNumber=`
   - 检查定稿存在、记忆就绪、草稿分歧、上下文缺口、未回收钩子
   - **不**自动改正文；不只看「生成」按钮

## 测试

- Node `npm run test:regression`：T21 / T22 / publish-check 等 G4 项
- Rust：`tests/g4/rust-story-g4-smoke.sh`

## 刻意未做（G5+）

- 关系图 / 多 Agent / 图数据库
- 批量自主写作 Agent
- 精确 tokenizer / 硬约束超预算强制 422（预算为估算展示）
