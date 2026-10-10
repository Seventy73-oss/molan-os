# G3：人物动态 · 有来源伏笔 · 知识过滤 · 再发布影响

基线计划：开源借鉴路线「G3：人物、伏笔、知识边界与改稿影响」。

## 已落地（rust-rewrite 为主，main Node 对等）

1. **人物动态字段**
   - 批准提案中的 `character_state_change`（location / injury / goal / inventory / relation / knows_fact）。
   - 截至第 N 章前投影：覆盖字段取最新；inventory/relation/knows 累积。
   - API：`GET /story/characters`、`GET /story/characters/:id/state?asOfChapter=&knowledgeMode=`。

2. **有来源伏笔事件 `hook_events`**
   - `planned|planted|developed|paid_off|abandoned`，带 publication / revision / 引文。
   - **计划回收章 ≠ 已回收**（T15）。
   - `paid_off` 才投影到旧 `hook_marks`。
   - API：`GET /story/foreshadowing?asOfChapter=`。

3. **知识过滤基础**
   - `story_knowledge_events`：author / reader / character。
   - 读者模式不注入 `audience=author` 秘密（T14）。
   - 上下文注入人物动态 + 有来源伏笔（作者模式）。

4. **再发布影响**
   - 替换定稿立即失效：facts / fact_sets / knowledge_events / hook_events。
   - `GET /story/impact`：列出将失效项、后章可能需复核；**不自动改正文**。

5. **设定卡内容版本**
   - `bible_card_revisions`：创建/更新时落 hash 快照。

6. **最小 UI**
   - 工具抽屉：「人物态」「伏笔」列表；影响摘要挂在人物态面板。

## 测试

- Node `npm run test:regression`：T03 / T14 / T15 / impact 等 G3 项。
- Rust：`tests/g3/rust-story-g3-smoke.sh`（characters / foreshadowing / impact / state）。

## 刻意未做（G4+）

- 关系图 / 多 Agent / 图数据库
- 复杂故事时间（仍按章节叙述顺序）
- 自动改写后章正文
- 完整预算裁剪 UI / 导出包恢复（G4）
