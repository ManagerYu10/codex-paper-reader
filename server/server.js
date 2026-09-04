import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readCached, writeCached, cacheStats, cacheDir } from "./pdf-cache.js";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = resolve(HERE, "extract.py");

// 扩展与服务的握手版本。改动请求/响应格式时必须 +1，否则新旧混用会报出无从下手的错。
export const PROTOCOL_VERSION = 2;
const DEFAULT_MODEL = "deepseek-v4-flash-vision-exp";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
// 原始 PDF 直接以二进制上传，不再走 base64，所以上限就是真实体积。
const MAX_PDF_BYTES = Math.max(1, Number(process.env.MAX_PDF_MB || 120)) * 1024 * 1024;
const MAX_HISTORY_TURNS = 24;
const MAX_TOKENS = 8000;

export function createServer(options = {}) {
  const documentStore = options.documentStore ?? new Map();
  const config = {
    apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
    accessToken: options.accessToken ?? process.env.READER_ACCESS_TOKEN ?? "",
    baseUrl: (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: options.model ?? process.env.READER_MODEL ?? DEFAULT_MODEL,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    extractImpl: options.extractImpl ?? extractPdf,
    sleepImpl: options.sleepImpl   // 只在测试里注入，省掉真实退避等待
  };

  return http.createServer(async (request, response) => {
    const origin = request.headers.origin || "";
    setCommonHeaders(response, origin);

    if (!isAllowedOrigin(origin)) {
      return sendJson(response, 403, { error: "只允许浏览器扩展访问本地阅读服务。" });
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }

    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      requireAccessToken(request, config.accessToken);

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          apiKeyConfigured: Boolean(config.apiKey),
          accessTokenRequired: Boolean(config.accessToken),
          model: config.model,
          maxPdfMb: Math.round(MAX_PDF_BYTES / 1024 / 1024)
        });
      }

      requireApiKey(config.apiKey);

      if (request.method === "POST" && requestUrl.pathname === "/api/documents") {
        // 两种投喂方式：扩展直接发字节，或只给 URL 让本地服务自己去取（省掉浏览器那次重复下载）
        const buffer = String(request.headers["content-type"] || "").includes("json")
          ? await fetchPdfByUrl((await readJson(request, 16 * 1024)).url, config)
          : await readBody(request, MAX_PDF_BYTES);
        assertPdf(buffer);
        const parsed = await config.extractImpl(buffer);
        assertReadable(parsed);

        const documentId = `doc_${randomUUID().replaceAll("-", "")}`;
        pruneDocumentStore(documentStore);
        documentStore.set(documentId, { ...parsed, createdAt: Date.now() });
        return sendJson(response, 201, {
          fileId: documentId,
          title: parsed.title,
          pages: parsed.pages,
          chars: parsed.chars,
          figurePages: parsed.figurePages,
          imageCount: parsed.images.length,
          scanned: Boolean(parsed.scanned)
        });
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/chat/stream") {
        const body = await readJson(request, 8 * 1024 * 1024);
        const document = documentStore.get(validateId(body.fileId, "doc"));
        // 404 是可恢复的：扩展收到后会自动重新上传，不需要用户操作。
        if (!document) throw httpError(404, "本地论文缓存已失效，正在重新读取原文。", true);
        // 必须 await：async 函数里直接 return promise，它的 rejection 会绕过下面的
        // catch 变成 unhandled rejection，Node 默认行为是杀掉整个进程。
        return await streamChat(config, buildMessages(body, document), response);
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/documents/delete") {
        const body = await readJson(request, 16 * 1024);
        return sendJson(response, 200, { deleted: documentStore.delete(validateId(body.fileId, "doc")) });
      }

      return sendJson(response, 404, { error: "接口不存在。" });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const message = status >= 500 && !error.expose ? "本地服务发生错误，请查看终端日志。" : error.message;
      if (status >= 500) console.error(error);
      return sendJson(response, status, { error: message });
    }
  });
}

/** 本地服务自己取 PDF：http(s) 走网络，file:// 直接读磁盘。 */
export async function fetchPdfByUrl(rawUrl, config = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw httpError(400, "PDF 地址无效。", true);
  }

  if (parsed.protocol === "file:") {
    try {
      // 本机直读，不需要浏览器的「允许访问文件网址」权限
      return await readFile(fileURLToPath(parsed));
    } catch {
      throw httpError(404, "读不到这个本地文件，请改用“选择本地 PDF”。", true);
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw httpError(400, "只支持 http、https 和本地文件。", true);
  }

  // 反复读同一篇论文时，整段下载都能省掉
  if (config.cache !== false) {
    const cached = await readCached(parsed.href);
    if (cached) {
      console.log(`PDF 缓存命中：${parsed.href} (${(cached.length / 1024 / 1024).toFixed(1)} MiB)`);
      return cached;
    }
  }

  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(parsed.href, {
    redirect: "follow",
    headers: {
      // 不少站点会对缺少 UA / Referer 的请求返回挡板页
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      Accept: "application/pdf,*/*",
      Referer: parsed.origin + "/"
    }
  }).catch(() => {
    throw httpError(502, "本地服务下载这个 PDF 失败。", true);
  });

  if (!response.ok) {
    // 401/403 多半是要登录，交回浏览器用你的 cookie 再试
    throw httpError(response.status === 404 ? 404 : 502,
      `下载 PDF 失败（HTTP ${response.status}），改用浏览器凭据重试。`, true);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) {
    throw httpError(413, `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MiB 限制。`, true);
  }
  // 缓存写失败不该影响这次请求，writeCached 自己吞掉异常
  if (config.cache !== false) await writeCached(parsed.href, buffer);
  return buffer;
}

/** 把 PDF 交给 PyMuPDF：全文带页码标记，含图表的页额外渲染成图。 */
export function extractPdf(buffer, pythonPath = process.env.PYTHON || "python3") {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [EXTRACTOR], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", () => reject(httpError(503,
      `找不到 ${pythonPath}。本地服务需要 python3 和 PyMuPDF：python3 -m pip install pymupdf`, true)));
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) {
        const hint = /No module named ['"]?fitz/.test(stderr)
          ? "缺少 PyMuPDF，请运行：python3 -m pip install pymupdf"
          : stderr.split("\n").pop() || `PDF 解析进程退出码 ${code}`;
        return reject(httpError(422, `解析 PDF 失败：${hint}`, true));
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch {
        reject(httpError(500, "PDF 解析结果不是合法 JSON。"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

export function buildMessages(body, document) {
  const message = String(body.message || "").trim();
  if (!message) throw httpError(400, "问题不能为空。", true);
  if (message.length > 20_000) throw httpError(400, "单次问题不能超过 20,000 个字符。", true);

  const language = body.language === "en" ? "English" : "简体中文";
  const system = [
    "你是一名严谨、善于解释复杂概念的学术论文阅读助手。",
    `默认使用${language}回答，专业术语可保留英文。`,
    "所有关于论文的事实性结论必须以用户提供的论文全文和页面图为依据。",
    "全文已按 ===== PAGE n ===== 切分，页面图也标了页码；引用时直接写该页码。",
    "明确区分：论文原文明确陈述、从数据可推出的结论、以及你的合理推断。",
    "精确数字和实现细节必须附可核验的页码、章节、表格或图；没有可靠位置时明确说论文未说明。",
    "不得用领域惯例补全论文未说明的模型版本、模块结构、超参数、数据规模或训练细节。",
    "注意区分人工标签与派生指标、平均与拼接、冻结原始权重与训练适配器、独立任务与联合输出。",
    "如果正文、公式或表格互相矛盾，指出冲突，不要静默挑选一个说法。",
    "不要生成推荐问题、值得追问的问题、下一步建议或邀请用户继续提问的结尾。",
    "使用清晰的 Markdown；先给直接答案，再展开依据。"
  ].join("\n");

  const parts = [{
    type: "text",
    text: `论文《${document.title}》全文如下（共 ${document.pages} 页，已按页切分）：\n${document.text}`
  }];
  if (document.images.length) {
    parts.push({
      type: "text",
      text: document.scanned
        ? `这份 PDF 抽不出文字层，下面是前 ${document.images.length} 页的页面原图，请直接从图上读取内容：`
        : `下面是含图表的 ${document.images.length} 个页面的原图，用于读取图、表和曲线中的信息：`
    });
    for (const image of document.images) {
      parts.push({ type: "text", text: `[第 ${image.page} 页]` });
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.b64}` } });
    }
  }

  // 论文这一轮放在最前且内容固定，DeepSeek 的上下文缓存才能在追问时命中。
  return [
    { role: "system", content: system },
    { role: "user", content: parts },
    { role: "assistant", content: "已读完论文全文和图表页，请提问。" },
    ...sanitizeHistory(body.history),
    { role: "user", content: message }
  ];
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => (turn?.role === "user" || turn?.role === "assistant") && typeof turn.content === "string")
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 20_000) }));
}

async function streamChat(config, messages, response) {
  const upstream = await deepseekFetch(config, {
    model: config.model,
    messages,
    thinking: { type: "disabled" },
    max_tokens: MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true }
  });
  if (!upstream.body) throw httpError(502, "DeepSeek 没有返回可读取的流。", true);

  response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
  response.flushHeaders?.();

  let usage = null;
  let text = "";
  let finishReason = "";
  try {
    for await (const event of parseSseEvents(upstream.body)) {
      if (event.error) throw new Error(event.error.message || "DeepSeek 流式响应失败。");
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        writeNdjson(response, { type: "delta", delta });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (event.usage) usage = event.usage;
    }
    if (!text.trim()) throw new Error("模型没有返回正文内容，请重试。");
    writeNdjson(response, { type: "done", usage, truncated: finishReason === "length" });
  } catch (error) {
    writeNdjson(response, { type: "error", error: error.message || "流式响应失败。" });
  } finally {
    response.end();
  }
}

// 限流和上游抖动会自己好，值得重试；余额、鉴权、请求本身有问题的不值得。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000];

function upstreamHint(status, message) {
  if (status === 402 || /insufficient balance/i.test(message)) {
    return `${message}（DeepSeek 账户余额不足，请到 platform.deepseek.com 充值；本地服务不需要重启）`;
  }
  if (status === 401) return `${message}（DEEPSEEK_API_KEY 无效，检查 ~/ZhangYu/.env 后重启服务）`;
  if (status === 429) return `${message}（触发限流，已自动重试仍未成功，稍后再试）`;
  return message;
}

async function deepseekFetch(config, payload) {
  if (typeof config.fetchImpl !== "function") {
    throw httpError(500, "当前 Node.js 不支持 fetch，请升级到 Node.js 20+。", true);
  }
  const sleep = config.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response;
    try {
      response = await config.fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (networkError) {
      // 连不上上游也是可重试的
      lastError = httpError(502, `连接 DeepSeek 失败：${networkError.message}`, true);
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw lastError;
    }
    if (response.ok) return response;

    const body = await response.json().catch(() => ({}));
    const message = String(body?.error?.message || body?.error || `DeepSeek 返回 HTTP ${response.status}`);
    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      console.warn(`[上游 ${response.status}] ${message} — ${RETRY_DELAYS_MS[attempt]}ms 后重试`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw httpError(response.status >= 500 ? 502 : response.status,
      upstreamHint(response.status, message), true);
  }
  throw lastError;
}

export async function* parseSseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const event = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) yield event;
}

function parseSseBlock(block) {
  const data = String(block || "")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    throw new Error("无法解析 DeepSeek 的流式事件。");
  }
}

export function assertPdf(buffer) {
  if (!buffer.length) throw httpError(400, "缺少 PDF 内容。", true);
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw httpError(400, "上传内容不是有效的 PDF 文件。", true);
  }
  return buffer;
}

/** 模型拿没拿到论文，必须在这里判死，不能让它自己去说“我看不到”。 */
export function assertReadable(parsed) {
  if (!parsed || typeof parsed.text !== "string" || !Array.isArray(parsed.images)) {
    throw httpError(500, "PDF 解析结果缺少字段。");
  }
  if (!parsed.text.trim() && parsed.images.length === 0) {
    throw httpError(422, "这份 PDF 既抽不出文字，也渲染不出页面图，无法解读。", true);
  }
  return parsed;
}

export function isAllowedOrigin(origin) {
  return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function writeNdjson(response, value) {
  if (response.writableEnded || response.destroyed) return;
  // 用户中途关掉阅读页时这里会 EPIPE，属于正常情况，不该冒泡。
  try {
    response.write(`${JSON.stringify(value)}\n`);
  } catch { /* 客户端已经走了 */ }
}

function pruneDocumentStore(store, maxDocuments = 6) {
  while (store.size >= maxDocuments) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) return;
    store.delete(oldestKey);
  }
}

function requireApiKey(apiKey) {
  if (!apiKey) throw httpError(503, "本地服务没有设置 DEEPSEEK_API_KEY。", true);
}

function requireAccessToken(request, expected) {
  if (!expected) return;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(request.headers["x-reader-token"] || ""));
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw httpError(401, "阅读器访问口令不正确。", true);
  }
}

function validateId(value, prefix) {
  const id = String(value || "");
  if (!new RegExp(`^${prefix}[-_][A-Za-z0-9_-]+$`).test(id)) throw httpError(400, `${prefix} ID 无效。`, true);
  return id;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, `PDF 超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 限制。`, true));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request, maxBytes) {
  const body = await readBody(request, maxBytes);
  if (body.subarray(0, 5).toString("ascii") === "%PDF-") {
    throw httpError(400, "本地服务版本过旧，收到了 PDF 字节却按 JSON 解析。请重启 npm start。", true);
  }
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw httpError(400, "请求 JSON 格式无效。", true);
  }
}

function setCommonHeaders(response, origin) {
  if (origin && isAllowedOrigin(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Reader-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response, status, value) {
  if (response.writableEnded) return;
  // 流式响应已经把头发出去了，这时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT。
  // 改成在同一条 NDJSON 流里补一个 error 事件，扩展本来就认这个格式。
  if (response.headersSent) {
    writeNdjson(response, { type: "error", error: value?.error || "本地服务发生错误。" });
    return void response.end();
  }
  const body = JSON.stringify(value);
  try {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  } catch {
    response.end();
  }
}

function httpError(status, message, expose = false) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  return error;
}

/**
 * 兜底层：这是一个本机开发服务，进程活着永远比退出好。
 * 上游 402/429、网络抖动、浏览器中途断开都不该让用户回去重跑 npm start。
 */
export function installProcessGuards(target = process) {
  target.on("unhandledRejection", (reason) => {
    console.error("[未处理的 Promise 拒绝] 服务继续运行：", reason?.message || reason);
  });
  target.on("uncaughtException", (error) => {
    // EPIPE / ECONNRESET 是客户端跑掉了，属于日常噪音
    if (error?.code === "EPIPE" || error?.code === "ECONNRESET") return;
    console.error("[未捕获异常] 服务继续运行：", error?.stack || error);
  });
}

export function startServer() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  installProcessGuards();
  const server = createServer();
  // 畸形请求不该掀翻整个服务
  server.on("clientError", (error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  // 端口被占，多半是上一次 npm start 的旧进程还活着。旧进程跑的是旧代码，
  // 改了文件也不会生效，扩展那边只会报「本地服务是旧版本」。直说怎么停。
  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`端口 ${port} 已被占用——上一次启动的服务还在跑，它用的是旧代码。`);
    console.error(`先停掉它再重来：  lsof -ti tcp:${port} | xargs kill`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Codex Paper Reader server: http://${host}:${port}`);
    console.log(`Model: ${process.env.READER_MODEL || DEFAULT_MODEL}`);
    console.log(process.env.DEEPSEEK_API_KEY ? "DeepSeek API key: configured" : "DeepSeek API key: MISSING");
    console.log(process.env.READER_ACCESS_TOKEN ? "Reader access token: required" : "Reader access token: not set (local use only)");
    probeExtractor();
    void cacheStats().then(({ files, bytes }) =>
      console.log(`PDF 缓存：${files} 篇 / ${(bytes / 1024 / 1024).toFixed(1)} MiB @ ${cacheDir()}`));
  });
  return server;
}

function probeExtractor() {
  const python = process.env.PYTHON || "python3";
  const child = spawn(python, ["-c", "import fitz; print(fitz.__doc__ or 'ok')"], { stdio: "ignore" });
  child.on("error", () => console.error(`PDF extractor: MISSING (找不到 ${python})`));
  child.on("close", (code) => console.log(code === 0
    ? "PDF extractor: PyMuPDF ready"
    : "PDF extractor: MISSING — 请运行 python3 -m pip install pymupdf"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
