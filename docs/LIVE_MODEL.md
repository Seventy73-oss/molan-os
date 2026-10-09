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
