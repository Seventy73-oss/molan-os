# 真实模型可选验收

默认 CI（`npm run test:audit`）**只走 local-draft**，不会消耗 API 额度。

## 何时跑

本机已配置可用的 OpenAI 兼容 Key，并愿意花一次极短请求时：

```bash
MOLAN_LIVE_MODEL=1 \
MOLAN_API_KEY=sk-... \
MOLAN_BASE_URL=https://api.openai.com/v1 \
MOLAN_MODEL=gpt-4o-mini \
npm run test:live-model
```

## 行为

| 条件 | 结果 |
|---|---|
| 未设 `MOLAN_LIVE_MODEL=1` | **SKIP**（exit 0） |
| 设了但缺 Key / Base URL | **SKIP**（exit 0，不发起请求） |
| 齐备 | 发一条极短 chat，断言非空短文本 |

正式生成路径仍无服务端静默本地降级：缺 Key 时 OpenAI 路由硬错误。

## 出站自动重试

模型相关出站（chat/completions、/models、连通探测）在 **网络错误** 或 **HTTP 5xx** 时会有限重试：默认再试 2 次（共 3 次），退避约 300ms → 600ms。

- **不重试**：HTTP 4xx（含 401/403/429）、用户取消、SSRF/白名单策略错误。
- **不静默降本地**：耗尽仍失败则原样报错，不会改走 `local-draft`。
- Node：`server/src/outbound.ts`（`MODEL_FETCH_RETRIES`）；Rust：`rust-server/src/outbound.rs` 对齐。

