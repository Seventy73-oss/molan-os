import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isPrivateOrReservedHost } from "../security";
import { ReferenceError } from "./errors";

export const SOURCE_ORIGIN = "http://www.shukuge.com";
export const SOURCE_NAME = "书库 · shukuge.com";
export type RemoteBook = { title: string; author: string; url: string };
export type RemoteChapter = { title: string; url: string; ordinal: number };
export type RemoteCatalog = RemoteBook & { chapters: RemoteChapter[] };
const cache = new Map<string, { at: number; value: RemoteCatalog }>();

export function sourceUrl(raw: string, kind: "book" | "chapter" | "request" = "request"): URL {
  let url: URL;
  try { url = new URL(raw, SOURCE_ORIGIN); } catch { throw new ReferenceError(400, "invalid_source_url", "书源地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "www.shukuge.com" || url.username || url.password || url.port || url.hash) {
    throw new ReferenceError(400, "source_not_allowed", "仅允许附件中已识别的书源，不接受任意网址");
  }
  const book = /^\/book\/\d+\/$/.test(url.pathname);
  const catalog = /^\/book\/\d+\/index\.html?$/.test(url.pathname);
  const chapter = /^\/book\/\d+\/\d+(?:\.html?)?$/.test(url.pathname);
  const search = url.pathname === "/Search" && [...url.searchParams.keys()].every(k => k === "wd");
  if ((kind === "book" && !book) || (kind === "chapter" && !chapter) || (kind === "request" && !book && !catalog && !chapter && !search) || (!search && url.search)) {
    throw new ReferenceError(400, "source_not_allowed", "不支持此书源路径");
  }
  return url;
}

export async function fetchSource(raw: string, signal?: AbortSignal, redirects = 0): Promise<string> {
  const url = sourceUrl(raw);
  const resolved = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!resolved.length || resolved.some(x => isPrivateOrReservedHost(x.address))) throw new ReferenceError(502, "source_dns_failed", "书源地址无法安全解析");
  const address = resolved[0]!;
  const response = await new Promise<{ status: number; location?: string; bytes: Buffer; type: string }>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.get(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18_000)]) : AbortSignal.timeout(18_000),
      // Pin the already-validated public IP. No second DNS lookup / rebinding window.
      lookup: (_hostname, options, cb) => {
        // Node 22's happy-eyeballs path requests an array when all:true.
        if (options.all) cb(null, [address]);
        else cb(null, address.address, address.family);
      },
      headers: { "User-Agent": "MolanReference/1.0", Accept: "text/html", "Accept-Encoding": "identity" },
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2_500_000) { res.destroy(); req.destroy(new Error("size")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode || 502, location: res.headers.location, bytes: Buffer.concat(chunks), type: String(res.headers["content-type"] || "") }));
    });
    req.on("error", reject);
  }).catch(() => {
    if (signal?.aborted) throw new ReferenceError(409, "cancelled", "已取消下载");
    throw new ReferenceError(502, "source_unavailable", "书源连接失败、证书无效或响应超限；可改用 TXT / Markdown 导入");
  });
  if (response.status >= 300 && response.status < 400 && response.location && redirects < 2) {
    const next = sourceUrl(new URL(response.location, url).href);
    return fetchSource(next.href, signal, redirects + 1);
  }
  if (response.status !== 200) throw new ReferenceError(502, "source_unavailable", `书源返回 ${response.status}；不会绕过付费、登录或访问限制`);
  if (response.type && !/text\/(html|plain)/i.test(response.type)) throw new ReferenceError(502, "source_invalid_content", "书源返回了非文本内容");
  const ascii = response.bytes.subarray(0, 5000).toString("latin1");
  const charset = /charset\s*=\s*["']?(gbk|gb2312|gb18030)/i.test(response.type + ascii) ? "gb18030" : "utf-8";
  return new TextDecoder(charset).decode(response.bytes);
}

export function cleanHtml(raw: string): string {
  return raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6])>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value: string) => { const n = value[0]?.toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, x: string) => ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[x.toLowerCase()] || ""))
    .replace(/\r/g, "").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseSearch(html: string): RemoteBook[] {
  const blocks = html.split(/<div\s+class=["']listitem clearfix["']\s*>/i).slice(1);
  const seen = new Set<string>(); const books: RemoteBook[] = [];
  for (const block of blocks) {
    const title = cleanHtml(block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "").slice(0, 200);
    const rawUrl = block.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
    if (!title || !rawUrl) continue;
    try {
      const url = sourceUrl(rawUrl, "book").href;
      if (seen.has(url)) continue; seen.add(url);
      books.push({ title, url, author: cleanHtml(block.match(/作者[:：]\s*([^<]*)/i)?.[1] || "").slice(0, 120) });
      if (books.length >= 50) break;
    } catch { /* Reject unexpected outbound links. */ }
  }
  if (!books.length && !/没有|暂无|未找到|无搜索|0\s*(?:本|条)/.test(cleanHtml(html))) {
    throw new ReferenceError(502, "source_changed", "书源页面结构已变更，暂无法解析；可使用文本导入");
  }
  return books;
}
export function parseCatalog(html: string, rawUrl: string): RemoteCatalog {
  const url = sourceUrl(rawUrl, "book");
  const title = cleanHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").replace(/\s*(?:TXT全集|最新章节)\s*$/i, "").trim().slice(0, 200);
  const chapters: RemoteChapter[] = []; const seen = new Set<string>();
  for (const match of html.matchAll(/<dd\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const chapterUrl = sourceUrl(new URL(match[1]!, url).href, "chapter");
      if (!chapterUrl.pathname.startsWith(url.pathname) || seen.has(chapterUrl.href)) continue;
      seen.add(chapterUrl.href);
      chapters.push({ url: chapterUrl.href, title: cleanHtml(match[2]!).slice(0, 200), ordinal: chapters.length + 1 });
      if (chapters.length > 10000) throw new ReferenceError(400, "catalog_too_large", "目录超过安全上限");
    } catch (error) { if (error instanceof ReferenceError && error.code === "catalog_too_large") throw error; }
  }
  if (!title || !chapters.length) throw new ReferenceError(502, "source_changed", "未找到可用章节目录，请改用文本导入");
  return { title, author: cleanHtml(html.match(/作者[:：]\s*(?:<[^>]+>\s*)?([^<\n]+)/i)?.[1] || "").slice(0, 120), url: url.href, chapters };
}
export function parseChapter(html: string): string {
  // Some pages nest a second #content inside a wrapper with navigation.
  // Select the innermost content container and balance divs instead of taking
  // the first closing div (which used to return only the chapter navigation).
  const safe = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const starts = [...safe.matchAll(/<div\b[^>]*\bid=["']content["'][^>]*>/gi)];
  const start = starts.at(-1);
  if (!start) throw new ReferenceError(502, "source_changed", "章节正文无法解析，不会绕过访问限制");
  const offset = start.index! + start[0].length; let depth = 1, end = -1;
  for (const tag of safe.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) { end = offset + tag.index!; break; }
  }
  if (end < 0) throw new ReferenceError(502, "source_changed", "章节正文无法解析，不会绕过访问限制");
  const raw = safe.slice(offset, end).replace(/<div\b[^>]*class=["'][^"']*\b(?:bottem1|bottom1|navigation|mygg)\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "");
  const text = cleanHtml(raw).split("\n").filter(line => !/^(?:推荐本书|最新章节|章节错误|投诉|举报|求收藏|求推荐)/.test(line.trim())).join("\n").trim();
  if (/此章节未予显示|章节已(?:删除|屏蔽)|正在手打中|内容更新后.{0,20}刷新|请(?:先)?登录.{0,15}(?:阅读|查看)|付费.{0,8}(?:阅读|解锁)|订阅本章/.test(text)) {
    throw new ReferenceError(502, "source_restricted", "书源未提供可用正文或该章节受限；不会绕过限制，请导入有权使用的文本");
  }
  if (text.length < 60 || text.length > 60000) throw new ReferenceError(502, "source_invalid_content", "章节正文过短或超过安全上限");
  return text;
}
export async function searchNovels(keyword: string, signal?: AbortSignal) {
  return parseSearch(await fetchSource(`${SOURCE_ORIGIN}/Search?wd=${encodeURIComponent(keyword)}`, signal));
}
export async function novelCatalog(rawUrl: string, signal?: AbortSignal): Promise<RemoteCatalog> {
  const url = sourceUrl(rawUrl, "book").href;
  const hit = cache.get(url); if (hit && Date.now() - hit.at < 300000) return hit.value;
  const detailHtml = await fetchSource(url, signal);
  let catalogHtml = detailHtml;
  // The attachment's book result is sometimes a detail page. Follow only the
  // exact same-book index link found on that page, not arbitrary navigation.
  const indexPath = new URL("index.html", url).pathname;
  const indexLink = [...detailHtml.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].some(match => {
    try { const link = sourceUrl(new URL(match[1]!, url).href); return link.pathname === indexPath; } catch { return false; }
  });
  if (indexLink && !/<dd\b[^>]*>\s*<a\b/i.test(detailHtml)) catalogHtml = await fetchSource(new URL(indexPath, url).href, signal);
  const value = parseCatalog(catalogHtml, url);
  if (!value.author) value.author = cleanHtml(detailHtml.match(/作者[:：]\s*(?:<[^>]+>\s*)?([^<\n]+)/i)?.[1] || "").slice(0, 120);
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), value });
  return value;
}
