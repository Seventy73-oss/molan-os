import fs from "node:fs";
import path from "node:path";
import { db, dataDir } from "./db";
import { secureFetch } from "./outbound";
import {
  assertSafeBaseUrl,
  assertSafeBaseUrlResolved,
  decryptSecret,
  encryptSecret,
  redactSecrets,
} from "./security";

const KEYS = {
  baseUrl: "image_base_url",
  apiKey: "image_api_key",
  model: "image_model",
  size: "image_size",
} as const;

export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_IMAGE_SIZE = "1024x1536";

export type ImageProviderView = {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  model: string;
  size: string;
  configured: boolean;
  keySource: "none" | "env" | "stored";
};

export type CoverResult = {
  file: string;
  url: string;
  model: string;
  prompt: string;
  generatedAt: string;
};

function read(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? "";
}

function write(key: string, value: string) {
  if (!value) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function keyHint(secret: string): string | null {
  if (secret.length < 4) return null;
  return `…${secret.slice(-4)}`;
}

function readStoredKey(): string {
  const raw = read(KEYS.apiKey);
  if (!raw) return "";
  try {
    return decryptSecret(raw);
  } catch {
    return "";
  }
}

function writeStoredKey(plain: string) {
  write(KEYS.apiKey, plain ? encryptSecret(plain) : "");
}

/** The image channel may live on a different provider than the text one. */
function envImageKey(): string {
  return process.env.MOLAN_IMAGE_API_KEY?.trim() || "";
}

export function imageProviderView(): ImageProviderView {
  const stored = readStoredKey();
  const env = envImageKey();
  const shown = env || stored;
  return {
    baseUrl: read(KEYS.baseUrl),
    hasApiKey: Boolean(shown),
    apiKeyHint: keyHint(shown),
    model: read(KEYS.model) || DEFAULT_IMAGE_MODEL,
    size: read(KEYS.size) || DEFAULT_IMAGE_SIZE,
    configured: Boolean(shown) && Boolean(read(KEYS.baseUrl)),
    keySource: env ? "env" : stored ? "stored" : "none",
  };
}

export function saveImageProvider(input: {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  size?: unknown;
  clearApiKey?: unknown;
}): ImageProviderView {
  if (typeof input.baseUrl === "string") {
    const next = input.baseUrl.trim();
    write(KEYS.baseUrl, next ? assertSafeBaseUrl(next, { withApiKey: false }) : "");
  }
  if (input.clearApiKey === true) writeStoredKey("");
  else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    const plain = input.apiKey.trim();
    if (plain.startsWith("enc:v1:")) throw new Error("无效的 API Key");
    writeStoredKey(plain);
  }
  if (typeof input.model === "string") write(KEYS.model, input.model.trim());
  if (typeof input.size === "string") write(KEYS.size, input.size.trim());
  return imageProviderView();
}

export function coversDir(): string {
  return path.join(dataDir, "covers");
}

function ensureCoversDir(): string {
  const dir = coversDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deterministic prompt: book identity in, cover art out. Never asks for lettering. */
export function buildCoverPrompt(book: {
  title: string;
  genre?: string | null;
  logline?: string | null;
  style?: string | null;
}): string {
  const parts = [
    `为一本中文小说绘制封面插画。书名《${book.title}》。`,
    book.genre ? `题材：${book.genre}。` : "",
    book.logline ? `故事：${book.logline}` : "",
    book.style ? `气质：${book.style}。` : "",
    "竖版构图，适合书籍封面，主体明确、有氛围与留白。",
    "画面里不要出现任何文字、字母、书名或水印。",
  ];
  return parts.filter(Boolean).join("");
}

type GenerationPayload = { data?: { b64_json?: string; url?: string }[]; error?: { message?: string } };

/** Extract image bytes from either response shape a compatible gateway may return. */
async function readImageBytes(payload: GenerationPayload, apiKey: string): Promise<Buffer> {
  const first = payload.data?.[0];
  if (!first) throw new Error(payload.error?.message || "接口没有返回图片");
  if (typeof first.b64_json === "string" && first.b64_json) {
    return Buffer.from(first.b64_json, "base64");
  }
  if (typeof first.url === "string" && first.url) {
    const response = await secureFetch(first.url, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      withApiKey: Boolean(apiKey),
      timeoutMs: 60_000,
      maxRedirects: 3,
    });
    if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("接口返回里既没有 b64_json 也没有 url");
}

function extensionFor(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length > 12 && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "png";
}

export type GenerateCoverInput = {
  bookId: string;
  title: string;
  genre?: string | null;
  logline?: string | null;
  style?: string | null;
  prompt?: string | null;
  size?: string | null;
};

/**
 * Generate a cover and store it under data/covers. The previous file is replaced,
 * so a failed regeneration leaves the old cover untouched (we write first, then swap).
 */
export async function generateCover(input: GenerateCoverInput): Promise<CoverResult> {
  const view = imageProviderView();
  const apiKey = envImageKey() || readStoredKey();
  if (!apiKey) throw new Error("还没有配置图片接口的 API Key");
  if (!view.baseUrl) throw new Error("还没有配置图片接口的 Base URL");

  const model = view.model;
  const size = (input.size || view.size || DEFAULT_IMAGE_SIZE).trim();
  const prompt = (input.prompt || "").trim() || buildCoverPrompt(input);

  const baseUrl = await assertSafeBaseUrlResolved(view.baseUrl, { withApiKey: true });
  const url = `${baseUrl.replace(/\/$/, "")}/images/generations`;

  const body: Record<string, unknown> = { model, prompt, n: 1, size };
  // Both response formats exist in the wild; ask for base64 and fall back to url.
  body.response_format = "b64_json";

  let response: Response;
  try {
    response = await secureFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      withApiKey: true,
      timeoutMs: 180_000,
      retries: 0,
    });
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : "图片接口连接失败"));
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`图片接口 HTTP ${response.status} ${redactSecrets(text).slice(0, 300)}`);
  }

  let payload: GenerationPayload;
  try {
    payload = JSON.parse(text) as GenerationPayload;
  } catch {
    throw new Error("图片接口返回的不是 JSON");
  }

  const bytes = await readImageBytes(payload, apiKey);
  if (bytes.length < 512) throw new Error("接口返回的图片太小，可能失败了");

  const dir = ensureCoversDir();
  const ext = extensionFor(bytes);
  const name = `${input.bookId}.${ext}`;
  const finalPath = path.join(dir, name);
  const tempPath = path.join(dir, `${input.bookId}.tmp`);
  fs.writeFileSync(tempPath, bytes);
  fs.renameSync(tempPath, finalPath);

  // Drop a previous cover in another format so the directory stays clean.
  for (const other of ["png", "jpg", "webp"]) {
    if (other === ext) continue;
    try {
      fs.unlinkSync(path.join(dir, `${input.bookId}.${other}`));
    } catch {
      /* not there */
    }
  }

  const generatedAt = new Date().toISOString();
  db.prepare("UPDATE books SET cover_file = ?, cover_at = ? WHERE id = ?").run(name, generatedAt, input.bookId);

  return { file: name, url: `/api/books/${input.bookId}/cover?v=${Date.parse(generatedAt)}`, model, prompt, generatedAt };
}

/** Absolute path of a book's cover, or null when there is none on disk. */
export function coverPath(book: { id: string; cover_file?: string | null }): string | null {
  const file = (book.cover_file || "").trim();
  if (!file) return null;
  const full = path.join(coversDir(), path.basename(file));
  return fs.existsSync(full) ? full : null;
}

export function deleteCover(bookId: string): void {
  const dir = coversDir();
  for (const ext of ["png", "jpg", "webp"]) {
    try {
      fs.unlinkSync(path.join(dir, `${bookId}.${ext}`));
    } catch {
      /* not there */
    }
  }
  db.prepare("UPDATE books SET cover_file = NULL, cover_at = NULL WHERE id = ?").run(bookId);
}
