// 按 URL 缓存下载过的 PDF。反复读同一篇论文时省掉整段下载——实测一篇 34 页的
// arXiv 论文，下载占了解析总耗时的绝大部分，本地 PyMuPDF 抽取只占几秒。
// 只缓存 http(s)：file:// 本来就是直读磁盘，再复制一份没有意义。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = resolve(HERE, "..", ".cache", "pdfs");
const PDF_MAGIC = Buffer.from("%PDF");

export function cacheDir() {
  return process.env.READER_CACHE_DIR || DEFAULT_CACHE_DIR;
}

export function cacheLimitBytes() {
  return Math.max(0, Number(process.env.READER_CACHE_MB || 2048)) * 1024 * 1024;
}

/**
 * 同一篇论文的几种写法应当命中同一条缓存，但**版本号必须保留**——
 * arXiv 的 v1 和 v2 是不同的稿子，合并会读到错的那一版。
 */
export function cacheKey(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\.pdf$/i, "").replace(/\/+$/, "");
  }
  return createHash("sha256").update(url.href).digest("hex").slice(0, 32);
}

const pdfPath = (key) => join(cacheDir(), `${key}.pdf`);

export async function readCached(rawUrl) {
  const key = cacheKey(rawUrl);
  if (!key) return null;
  try {
    const buffer = await readFile(pdfPath(key));
    // 半截文件（上次写到一半被杀）不能当命中用
    if (buffer.length < 5 || !buffer.subarray(0, 4).equals(PDF_MAGIC)) {
      await unlink(pdfPath(key)).catch(() => {});
      return null;
    }
    const now = new Date();
    await utimes(pdfPath(key), now, now).catch(() => {});   // LRU 用访问时间
    return buffer;
  } catch {
    return null;
  }
}

export async function writeCached(rawUrl, buffer) {
  const key = cacheKey(rawUrl);
  if (!key || !buffer?.length || !buffer.subarray(0, 4).equals(PDF_MAGIC)) return false;
  const limit = cacheLimitBytes();
  if (limit === 0 || buffer.length > limit) return false;
  try {
    await mkdir(cacheDir(), { recursive: true });
    // 先写临时文件再改名，避免进程被杀时留下半截 PDF
    const temp = `${pdfPath(key)}.${process.pid}.tmp`;
    await writeFile(temp, buffer);
    const { rename } = await import("node:fs/promises");
    await rename(temp, pdfPath(key));
    await evict(limit);
    return true;
  } catch {
    return false;
  }
}

/** 超出上限就按最久未用逐个删，直到降到上限以内。 */
export async function evict(limit = cacheLimitBytes()) {
  let entries;
  try {
    entries = await readdir(cacheDir());
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith(".pdf")) continue;
    const full = join(cacheDir(), name);
    try {
      const info = await stat(full);
      files.push({ full, size: info.size, used: info.atimeMs || info.mtimeMs });
    } catch { /* 正在被别的进程删 */ }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  files.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const file of files) {
    if (total <= limit) break;
    try {
      await unlink(file.full);
      total -= file.size;
      removed += 1;
    } catch { /* 已经没了 */ }
  }
  return { removed, bytes: total };
}

export async function cacheStats() {
  try {
    const names = (await readdir(cacheDir())).filter((n) => n.endsWith(".pdf"));
    let bytes = 0;
    for (const name of names) {
      try { bytes += (await stat(join(cacheDir(), name))).size; } catch { /* 竞态 */ }
    }
    return { files: names.length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}
