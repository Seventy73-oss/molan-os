# 代码审查修复：AI 写稿 CAS / stream beginGeneration / skillIds 场景过滤

日期：2026-10-10  
仓库：molan-os

## 背景

审查指出三条：

1. `chat` → `executeScene`、以及 `streamSceneRun` 写稿时未带写前 `expectedRevisionId`，长生成期间用户保存会被无冲突覆盖。
2. `scene-runs/stream` 虽收 `generationId`，但未 `beginGeneration`，取消/幂等对该 API 失效。
3. 显式 `skillIds` 可能跨阶段硬挂用户包（如大纲挂上 humanize）。

## 改动

### 1. 写前基线 + 冲突落候选

- 新增 `currentRevisionIdFor(bookId, kind, chapterNumber)`。
- `saveRevision` 增加 `onConflict: "throw" | "candidate"`（默认 `throw` → 409）；`candidate` 时冲突插入修订但不设当前，返回 `conflicted: true`。
- `executeScene` / `streamSceneRun`：模型调用**前**捕获当前修订为基线；保存时带 `expectedRevisionId`，默认 `onConflict: "candidate"`。
- 同步 `POST /scene-runs` 与 `/scene-runs/stream` 可传 `expectedRevisionId` / `onConflict`。
- `chat` 走 `executeScene` 时自动享受同一套基线捕获。

### 2. streamSceneRun beginGeneration

- 有 `generationId` 时先 `beginGeneration`（写入 `baseRevisionId`）。
- 复用已完成结果直接 `done`；`running` / `cancelled` → 409；`failed` → 502。

### 3. skillIds × attachScenes

- `skillsForScene`：显式用户包 id 仅当 `attachScenes` 含当前场景才附加；阶段矩阵强制挂载不变。

## 测试

| 套件 | 结果 |
|---|---|
| typecheck | 通过 |
| test:regression | 66/66 |
| test:e2e | 78/78 |

新增断言：跨阶段 skillIds 过滤、CAS 候选、`executeScene` 冲突保用户稿、`streamSceneRun` beginGeneration + 幂等复用。

## 行为说明

- 人类 `PUT /artifacts` 仍默认冲突 409。
- AI 主路径冲突默认落**候选稿**，不盖用户当前稿，结果留在版本历史。
- 调用方可显式 `onConflict: "throw"` 要求硬 409。
