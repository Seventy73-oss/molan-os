/**
 * Optional live-model acceptance. Default: SKIP (no spend).
 *
 * Enable only when you intentionally want a real provider call:
 *   MOLAN_LIVE_MODEL=1 MOLAN_API_KEY=... MOLAN_BASE_URL=https://api.openai.com/v1 MOLAN_MODEL=gpt-4o-mini \
 *     npm run test:live-model
 *
 * Requires Key + Base URL. Never runs in default CI / test:audit.
 */
import os from "node:os";
import path from "node:path";

const enabled = (process.env.MOLAN_LIVE_MODEL || "").trim() === "1";
const apiKey = (process.env.MOLAN_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const baseUrl = (process.env.MOLAN_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
const model = (process.env.MOLAN_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

if (!enabled) {
  console.log("SKIP  live-model — set MOLAN_LIVE_MODEL=1 and provide Key to run (see docs/LIVE_MODEL.md)");
  process.exit(0);
}
if (!apiKey || !baseUrl) {
  console.log("SKIP  live-model — MOLAN_LIVE_MODEL=1 but missing MOLAN_API_KEY / MOLAN_BASE_URL (no spend)");
  process.exit(0);
}

const tmpDb = path.join(os.tmpdir(), `molan-live-${Date.now()}.sqlite`);
process.env.MOLAN_SQLITE_PATH = tmpDb;
process.env.MOLAN_SECRET = process.env.MOLAN_SECRET || "live-model-test-secret-material-32b!";
delete process.env.DATABASE_URL;
delete process.env.MOLAN_DB;
// Ensure provider env is visible
process.env.MOLAN_API_KEY = apiKey;
process.env.MOLAN_BASE_URL = baseUrl;
process.env.MOLAN_MODEL = model;

const { OpenAICompatibleAdapter } = await import("../src/agent/openai");
const adapter = new OpenAICompatibleAdapter({ baseUrl, apiKey, model });
const out = await adapter.runScene({
  scene: "chat",
  skillTexts: [],
  context: "请只回复两个字：通过",
  instruction: "极短确认",
  thinkingIntensity: "off",
});
const text = (out.text || "").trim();
const ok = text.length > 0 && text.length < 200;
console.log(`${ok ? "PASS" : "FAIL"}  live-model 返回非空短文本 — model=${out.modelUsed} text=${JSON.stringify(text).slice(0, 120)}`);
if (!ok) process.exit(1);
console.log("live-model: 1/1 passed");
