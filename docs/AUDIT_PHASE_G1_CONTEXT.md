# G1 / P0：上下文三栏接入与 ContextSnapshot

基线计划：开源借鉴路线文档「G1：接通上下文闭环与快照」。

## 已落地

1. **【设定卡】** 从 `bible_cards` 注入（人物/物件/地点）。
2. **【前文记忆】** 注入 `chapter_number < 当前章` 的 `chapter_memory`：
   - `source_revision_id` 与该章正文 `current_revision_id` 匹配 → 注入；
   - 无来源 → `legacy_current` 标注后注入；
   - 源版本过期 → **不注入**（记入 manifest.excluded）。
3. **【未回收钩子】** 复用 `list_hooks` 活跃项（`open` / `warning`，且 `fromChapter < 当前章`）。
4. **ContextSnapshot**：表 `context_snapshots`；场景执行 / chat / stream 持久化渲染文本 + hash + manifest。
5. **API**：`GET /api/books/:id/context-preview?chapterNumber=`（Node + Rust）。
6. **UI**：工作室设置区显示「设定卡 / 前文记忆 / 钩子」计数与首条缺失提示。
7. **模式**：明确 `legacy_current`（尚无正式定稿协议）。
8. **审核场景**：跨章未回收钩子块注入 instruction（Rust 对齐 Node）。

## 测试

- Node `npm run test:regression`：含 T01 七项（设定卡/记忆/钩子/过期排除/legacy 标注/preview/snapshot）全绿。
- Rust：`context-preview` 冒烟验证三栏非空且 source_matched。
- `npm run typecheck` 通过；`cargo build` 通过。

## 刻意未做（路线后续）

- G2 定稿 / 提案批准 / outbox / story epoch → 见 `AUDIT_PHASE_G2_STORY.md`
- G3 人物动态状态、有来源伏笔账本、知识边界
- 知识图谱、多 Agent、完整预算裁剪算法
- 正式 `published_only` 模式（当前仅 legacy_current）
