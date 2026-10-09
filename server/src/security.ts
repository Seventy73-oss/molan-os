/**
 * Local-first safety helpers: bind/CORS allowlists, provider URL SSRF checks,
 * API-key encryption at rest, and secret redaction in error strings.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET_PATH = join(ROOT, "data", ".molan-secret");

const ENC_PREFIX = "enc:v1:";

/** Default public OpenAI-compatible hosts. Extend via MOLAN_ALLOWED_BASE_HOSTS. */
export const DEFAULT_ALLOWED_BASE_HOSTS = [
  "api.openai.com",
  "api.deepseek.com",
  "api.siliconflow.cn",
  "api.moonshot.cn",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "open.bigmodel.cn",
  "dashscope.aliyuncs.com",
  "ark.cn-beijing.volces.com",
  "api.groq.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.mistral.ai",
  "api.x.ai",
];

export function listenHostname(): string {
  const raw = (process.env.MOLAN_HOST || process.env.HOST || "127.0.0.1").trim();
  return raw || "127.0.0.1";
}

/** Origins allowed for CORS (local Vite + optional MOLAN_CORS_ORIGINS). */
export function corsAllowedOrigins(): string[] {
  const defaults = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ];
  const extra = (process.env.MOLAN_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...extra])];
}

export function isCorsOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // same-origin / curl / server-side
  return corsAllowedOrigins().includes(origin);
}

function parseHostList(envName: string): string[] {
  return (process.env[envName] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedBaseHosts(): Set<string> {
  const set = new Set(DEFAULT_ALLOWED_BASE_HOSTS.map((h) => h.toLowerCase()));
  for (const host of parseHostList("MOLAN_ALLOWED_BASE_HOSTS")) set.add(host);
  return set;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function ipv4ToInt(host: string): number {
  const parts = host.split(".").map(Number);
  return ((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) + ((parts[2]! << 8) >>> 0) + parts[3]!;
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;

  if (isIpv4(host)) {
    const n = ipv4ToInt(host);
    const inRange = (a: string, b: string) => n >= ipv4ToInt(a) && n <= ipv4ToInt(b);
    if (inRange("0.0.0.0", "0.255.255.255")) return true;
    if (inRange("10.0.0.0", "10.255.255.255")) return true;
    if (inRange("127.0.0.0", "127.255.255.255")) return true;
    if (inRange("169.254.0.0", "169.254.255.255")) return true; // link-local / cloud metadata
    if (inRange("172.16.0.0", "172.31.255.255")) return true;
    if (inRange("192.168.0.0", "192.168.255.255")) return true;
    if (inRange("100.64.0.0", "100.127.255.255")) return true; // CGNAT
    if (inRange("192.0.0.0", "192.0.0.255")) return true;
    if (inRange("192.0.2.0", "192.0.2.255")) return true;
    if (inRange("198.51.100.0", "198.51.100.255")) return true;
    if (inRange("203.0.113.0", "203.0.113.255")) return true;
    if (inRange("224.0.0.0", "255.255.255.255")) return true;
    return false;
  }

  // IPv6 condensed checks
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
    if (host.startsWith("::ffff:")) {
      const v4 = host.slice("::ffff:".length);
      if (isIpv4(v4)) return isPrivateOrReservedHost(v4);
    }
  }
  return false;
}

export type SafeUrlOptions = {
  /** When true, host must be on the public allowlist (or MOLAN_ALLOWED_BASE_HOSTS). */
  withStoredKey?: boolean;
  /** Allow private/loopback hosts when MOLAN_ALLOW_LOCAL_LLM=1 and host is localhost-like. */
  allowLocalLlm?: boolean;
};

function localLlmAllowed(): boolean {
  const v = (process.env.MOLAN_ALLOW_LOCAL_LLM || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Validate a provider Base URL before attaching credentials.
 * - http/https only, no userinfo
 * - blocks private/metadata hosts unless local LLM mode + allowlisted host
 * - when using a *stored* API key, host must be on the allowlist (prevents key exfil to arbitrary URLs)
 */
export function assertSafeBaseUrl(raw: string, options: SafeUrlOptions = {}): string {
  const text = raw.trim();
  if (!text) throw new Error("Base URL 不能为空");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL 需要是 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 只接受 http 或 https");
  }
  if (url.username || url.password) throw new Error("不要把密钥写进地址");
  if (url.hostname.includes("%")) throw new Error("Base URL 主机名不合法");

  const host = url.hostname.toLowerCase();
  const allowLocal = options.allowLocalLlm ?? localLlmAllowed();
  const privateHost = isPrivateOrReservedHost(host);

  if (privateHost) {
    if (!allowLocal) {
      throw new Error("禁止把接口指到内网/本机地址（SSRF 防护）。本地模型请设 MOLAN_ALLOW_LOCAL_LLM=1，并把主机加入 MOLAN_ALLOWED_BASE_HOSTS");
    }
    if (!allowedBaseHosts().has(host) && host !== "127.0.0.1" && host !== "localhost") {
      throw new Error(`内网主机 ${host} 未在 MOLAN_ALLOWED_BASE_HOSTS 白名单中`);
    }
  }

  if (options.withStoredKey) {
    const allowed = allowedBaseHosts();
    if (allowLocal && (host === "127.0.0.1" || host === "localhost")) {
      // ok when local LLM mode is on
    } else if (!allowed.has(host)) {
      throw new Error(
        `使用已保存的 API Key 时，Base URL 主机必须在白名单内（当前 ${host} 不在）。可设 MOLAN_ALLOWED_BASE_HOSTS，或先清空/改用环境变量密钥后再试自定义地址`,
      );
    }
  }

  return text.replace(/\/+$/, "");
}

/** Async DNS check: resolve hostname and reject private IPs (DNS rebinding). */
export async function assertSafeBaseUrlResolved(raw: string, options: SafeUrlOptions = {}): Promise<string> {
  const cleaned = assertSafeBaseUrl(raw, options);
  const url = new URL(cleaned);
  const host = url.hostname.toLowerCase();
  if (isIpv4(host) || host.includes(":")) return cleaned;
  if (host === "localhost") return cleaned;
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    for (const row of results) {
      if (isPrivateOrReservedHost(row.address)) {
        const allowLocal = options.allowLocalLlm ?? localLlmAllowed();
        if (!allowLocal) {
          throw new Error(`主机 ${host} 解析到内网地址 ${row.address}，已拒绝（SSRF 防护）`);
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("SSRF")) throw error;
    // DNS failure: still allow allowlisted public hosts; lookup may fail offline
  }
  return cleaned;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…")
    .replace(/sk-proj-[A-Za-z0-9_-]{8,}/g, "sk-proj-…")
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer …")
    .replace(/Authorization["']?\s*[:=]\s*["']?Bearer\s+[^\s"'\\]+/gi, "Authorization: Bearer …")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^\s"'&,}{]+/gi, "api_key=…")
    .replace(/MOLAN_API_KEY["']?\s*[:=]\s*["']?[^\s"'&,}{]+/gi, "MOLAN_API_KEY=…")
    .replace(/OPENAI_API_KEY["']?\s*[:=]\s*["']?[^\s"'&,}{]+/gi, "OPENAI_API_KEY=…")
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]{16,}/g, "enc:v1:…")
    .slice(0, 220);
}

function ensureSecretMaterial(): Buffer {
  const fromEnv = (process.env.MOLAN_SECRET || process.env.MOLAN_ENCRYPTION_KEY || "").trim();
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();
  try {
    if (existsSync(SECRET_PATH)) {
      const raw = readFileSync(SECRET_PATH, "utf8").trim();
      if (raw.length >= 32) return createHash("sha256").update(raw).digest();
    }
  } catch {
    // fall through to generate
  }
  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
  } catch {
    // if we cannot persist, still use ephemeral (keys won't decrypt across restarts)
  }
  return createHash("sha256").update(generated).digest();
}

/** Encrypt API key for DB storage. Returns enc:v1:iv:tag:ciphertext (base64 parts). */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(ENC_PREFIX)) return plain;
  const key = ensureSecretMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Decrypt DB value; plaintext legacy values pass through. */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("密钥密文损坏");
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const key = ensureSecretMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return out.toString("utf8");
}

/** Env key preferred for runtime; never written to API responses. */
export function envApiKey(): string {
  return (
    process.env.MOLAN_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export { ENC_PREFIX };
