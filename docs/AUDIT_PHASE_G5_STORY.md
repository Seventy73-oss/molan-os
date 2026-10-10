# G5：同源派生视图 · 有审批点的批量记忆 · 禁止无约束 Agent

基线计划：开源借鉴路线「G5：图谱与有审批点的批量／Agent 能力」。

## 已落地（rust-rewrite 为主，main Node 对等）

1. **关系图 / 时间线 / 伏笔视图（派生，非第二权威）**
   - `GET /api/books/:id/story/views/relations?asOfChapter=`
   - `GET /api/books/:id/story/views/timeline?asOfChapter=`
   - `GET /api/books/:id/story/views/hooks?asOfChapter=`
   - 权威表：`bible_cards` / `story_facts` / `chapter_publications` / `hook_events` / `story_knowledge_events`
   - 响应带 `derived: true` 与 `authority` 列表；**不**引入图数据库

2. **批量记忆 ready（审批门 + 取消 + 成本上限）**
   - `POST /api/books/:id/story/batch/memory-ready`
   - `POST .../batch/:batchId/tick|resume|cancel`、`GET .../batch/:batchId`
   - 严格模式：无定稿 / 待审批 / 成本上限 → `paused_gate`
   - `autoExtract` 只生成 **提案**，不静默写正式事实
   - `majorChangeRequiresApproval` 默认 true；`gates.writesOnlyViaStoryLedger=true`

3. **只读审查器**
   - `POST /api/books/:id/story/review/readonly`
   - `writable: false`；汇总 publish-check / impact / 未回收伏笔；**不写回**

4. **禁止无约束多 Agent 编排**
   - `POST /api/books/:id/story/agent/orchestrate` → **422**
   - pi / 批量均不注册 tools；写回仍走 StoryLedger（定稿 / 提案批准）

5. **UI**
   - 工具抽屉「图谱」：关系 / 时间线 / 伏笔视图 / 批量记忆

## 测试

- Node `npm run test:regression`：G5 关系边、时间线、批量门、取消、成本上限、422、批准后 resume
- Rust：`tests/g5/rust-story-g5-smoke.sh`

## 刻意未做（产品边界）

- 无图数据库 / 无自主多 Agent 工具编排
- 批量不自动改正文、不自动批准重大提案
- 复杂故事时间仍按章节叙述顺序
