# pi 运行时边界

墨兰写作里的 **pi-agent**（`@earendil-works/pi-agent-core`）是 **模型代调（model relay）**，不是自主工具编排 agent。

## 会做什么

- 按场景拼 prompt，调用 OpenAI 兼容接口或本地草稿生成文稿
- 把结果经 pi `Agent` + faux provider 走一遍运行时路径并交付中文稿
- 对白引号规范化等写作侧后处理

## 不会做什么

- 不注册、不执行 tools / function calling 编排
- 不自主多步规划、不访问外部工具链
- 若 `RunInput` 带 `tools` / `enableTools` / `autonomous` / `orchestration` 等字段，**直接拒绝**

## 如何启用

- 场景路由 `provider=pi`，或环境变量 `MOLAN_AGENT_RUNTIME=pi`（兼容 `CHANGJUAN_AGENT_RUNTIME`）
- 模型页「写作运行时」会显示能力与边界说明（`pi.autonomous=false`）

## 验收

- 回归 / E2E 断言 capability 文案含「非自主」且 `assertPiModelRelayOnly` 拒工具字段
