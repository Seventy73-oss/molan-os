# G2：定稿指针 · 记忆提案 · epoch / 幂等 · 替换失效

基线计划：开源借鉴路线「G2：定稿、提案批准和持久任务」。

## 已落地（rust-rewrite 为主，main Node 对等）

1. **定稿指针 `chapter_publications`**  
   - 与编辑器 `current_revision_id` 分离。  
   - `POST .../story/chapters/:chapterId/finalize` 要求显式 `expectedPublicationId`（`null`=首次）。  
   - 响应：`publicationId` / `storyEpoch` / `memoryState=pending`，不谎报记忆已就绪。

2. **记忆提取 → 提案**  
   - 有活跃定稿后，正文保存不再自动改正式记忆。  
   - 定稿后 outbox + 异步抽取（`skipPersist`）生成 `memory_proposals`。  
   - 作者 `apply` 选中操作后才写入 `chapter_memory` 与 `story_facts`。

3. **book epoch / 幂等**  
   - `story_book_heads.story_epoch` / `fact_set_version`。  
   - `story_operation_results`：同键同参返回原结果；同键异参 → `IDEMPOTENCY_KEY_REUSED`。

4. **替换定稿立即失效**  
   - 旧 publication → `superseded`；旧 facts / fact_sets → `invalidated`；未决提案 → `stale`。  
   - 上下文按 **publication body revision** 匹配记忆（`published_only`），草稿分歧不污染正式前文记忆。

5. **最小 UI**  
   - 工作室：保存旁「定稿」；有提案时「接受记忆提案」；「草稿≠定稿」提示。

## API

| 方法 | 路径 |
|---|---|
| GET | `/api/books/:id/story/head` |
| GET | `/api/books/:id/story/status?chapterNumber=` |
| GET | `/api/books/:id/story/chapters/:chapterId/status` |
| POST | `/api/books/:id/story/chapters/:chapterId/finalize` |
| POST | `/api/books/:id/story/memory/extract` |
| GET | `/api/books/:id/story/memory/proposals/:proposalId` |
| POST | `/api/books/:id/story/memory/proposals/:proposalId/apply` |
| POST | `/api/books/:id/story/memory/proposals/:proposalId/reject` |

## 测试

- Node `npm run test:regression`：含 T04–T09 / T05–T07 G2 项。  
- Rust：`cargo build`；API 冒烟见本阶段推送说明。

## 刻意未做（G3+）

- 人物动态状态 / 有来源伏笔账本 / 知识边界  
- 关系图、多 Agent  
- 完整 outbox worker 租约 fencing 与崩溃注入矩阵（表已建，抽取以进程内 spawn 为主）  
- 旧书批量「一键升为定稿」向导  
