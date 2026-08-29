import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "gpt-5.6-luna";
const ALLOWED_MODELS = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const ALLOWED_REASONING = new Set(["none", "low", "medium", "high"]);
const MAX_PDF_BYTES = Math.max(1, Number(process.env.MAX_PDF_MB || 50)) * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_PDF_BYTES * 1.4) + 1024 * 1024;

export function createServer(options = {}) {
  const documentStore = options.documentStore ?? new Map();
  const config = {
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    accessToken: options.accessToken ?? process.env.READER_ACCESS_TOKEN ?? "",
    openaiBaseUrl: (options.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    fetchImpl: options.fetchImpl ?? globalThis.fetch
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
          apiKeyConfigured: Boolean(config.apiKey),
          accessTokenRequired: Boolean(config.accessToken),
          defaultModel: DEFAULT_MODEL,
          documentMode: "inline"
        });
      }

      requireApiKey(config.apiKey);

      if (request.method === "POST" && requestUrl.pathname === "/api/documents") {
        const body = await readJson(request, MAX_JSON_BYTES);
        const buffer = decodePdf(body.pdfBase64);
        const filename = sanitizeFilename(body.filename || "paper.pdf");
        const documentId = `doc_${randomUUID().replaceAll("-", "")}`;
        pruneDocumentStore(documentStore);
        documentStore.set(documentId, {
          filename,
          pdfBase64: buffer.toString("base64"),
          bytes: buffer.length,
          createdAt: Date.now()
        });
        return sendJson(response, 201, { fileId: documentId, filename, bytes: buffer.length });
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
        const body = await readJson(request, 64 * 1024);
        const documentId = validateId(body.fileId, "doc");
        const document = documentStore.get(documentId);
        if (!document) throw httpError(404, "本地 PDF 缓存已失效，请点击“新会话”后重试。", true);
        const payload = buildResponsePayload(body, document);
        const modelResponse = await openaiJson(config, "/responses", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        return sendJson(response, 200, {
          responseId: modelResponse.id,
          outputText: extractOutputText(modelResponse),
          usage: modelResponse.usage || null
        });
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/chat/stream") {
        const body = await readJson(request, 64 * 1024);
        const documentId = validateId(body.fileId, "doc");
        const document = documentStore.get(documentId);
        if (!document) throw httpError(404, "本地 PDF 缓存已失效，请点击“新会话”后重试。", true);
        const payload = { ...buildResponsePayload(body, document), stream: true };
        return streamOpenAIResponse(config, payload, response);
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/documents/delete") {
        const body = await readJson(request, 16 * 1024);
        const documentId = validateId(body.fileId, "doc");
        const deleted = documentStore.delete(documentId);
        return sendJson(response, 200, { deleted });
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

export function buildResponsePayload(body, document = null) {
  const fileId = validateId(body.fileId, document ? "doc" : "file");
  const previousResponseId = body.previousResponseId ? validateId(body.previousResponseId, "resp") : "";
  const message = String(body.message || "").trim();
  if (!message) throw httpError(400, "问题不能为空。", true);
  if (message.length > 20_000) throw httpError(400, "单次问题不能超过 20,000 个字符。", true);

  const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const effort = ALLOWED_REASONING.has(body.reasoningEffort) ? body.reasoningEffort : "none";
  const language = body.language === "en" ? "English" : "简体中文";
  const instructions = [
    "你是一名严谨、善于解释复杂概念的学术论文阅读助手。",
    `默认使用${language}回答，专业术语可保留英文。`,
    "所有关于论文的事实性结论必须以用户提供的 PDF 为依据。",
    "明确区分：论文原文明确陈述、从数据可推出的结论、以及你的合理推断。",
    "尽可能标注页码、章节、图表或公式位置；无法确认位置时不要编造引用。",
    "不得用领域惯例补全论文未说明的模型版本、模块结构、超参数、数据规模或训练细节。",
    "精确数字和实现细节应附可核验的章节、表格、图、公式或页码；没有可靠位置时明确说论文未说明。",
    "注意区分人工标签与派生指标、平均与拼接、冻结原始权重与训练适配器、独立任务与联合输出。",
    "如果正文、公式或表格互相矛盾，指出冲突，不要静默挑选一个说法。",
    "遇到证据不足、实验缺失或定义含糊时直接指出。",
    "不要生成推荐问题、值得追问的问题、下一步建议或邀请用户继续提问的结尾。",
    "使用清晰的 Markdown；先给直接答案，再展开依据。"
  ].join("\n");

  const fileInput = document
    ? {
        type: "input_file",
        filename: document.filename,
        file_data: `data:application/pdf;base64,${document.pdfBase64}`,
        detail: "auto"
      }
    : { type: "input_file", file_id: fileId, detail: "auto" };

  const input = previousResponseId
    ? message
    : [{
        role: "user",
        content: [
          fileInput,
          { type: "input_text", text: message }
        ]
      }];

  return {
    model,
    instructions,
    input,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    reasoning: { effort },
    text: { verbosity: "low" },
    max_output_tokens: 4000,
    store: true
  };
}

export function decodePdf(pdfBase64) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    throw httpError(400, "缺少 PDF 内容。", true);
  }
  const clean = pdfBase64.replace(/^data:application\/pdf;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw httpError(400, "PDF Base64 编码无效。", true);
  const buffer = Buffer.from(clean, "base64");
  if (!buffer.length || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw httpError(400, "上传内容不是有效的 PDF 文件。", true);
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw httpError(413, `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MiB 限制。`, true);
  }
  return buffer;
}

export function extractOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((content) => content?.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n\n");
}

export function isAllowedOrigin(origin) {
  return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

async function openaiJson(config, path, init) {
  const response = await openaiFetch(config, path, init);
  return response.json().catch(() => ({}));
}

async function openaiFetch(config, path, init) {
  if (typeof config.fetchImpl !== "function") throw httpError(500, "当前 Node.js 不支持 fetch，请升级到 Node.js 20+。", true);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");

  const response = await config.fetchImpl(`${config.openaiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body?.error?.message || body?.error || `OpenAI API 返回 HTTP ${response.status}`;
    throw httpError(response.status >= 500 ? 502 : response.status, message, true);
  }
  return response;
}

async function streamOpenAIResponse(config, payload, response) {
  const upstream = await openaiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!upstream.body) throw httpError(502, "OpenAI API 没有返回可读取的流。", true);

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders?.();

  let completed = null;
  try {
    for await (const event of parseSseEvents(upstream.body)) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        writeNdjson(response, { type: "delta", delta: event.delta });
      } else if (event.type === "response.completed") {
        completed = event.response || null;
      } else if (event.type === "response.failed" || event.type === "error") {
        throw new Error(streamErrorMessage(event));
      }
    }

    if (!completed?.id) throw new Error("OpenAI 流式响应在完成前意外结束。");
    writeNdjson(response, {
      type: "done",
      responseId: completed.id,
      usage: completed.usage || null
    });
  } catch (error) {
    writeNdjson(response, { type: "error", error: error.message || "流式响应失败。" });
  } finally {
    response.end();
  }
}

export async function* parseSseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
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
    throw new Error("无法解析 OpenAI 的流式事件。");
  }
}

function streamErrorMessage(event) {
  return event?.response?.error?.message || event?.error?.message || event?.message || "OpenAI 流式响应失败。";
}

function writeNdjson(response, value) {
  if (!response.writableEnded) response.write(`${JSON.stringify(value)}\n`);
}

function pruneDocumentStore(store, maxDocuments = 6) {
  while (store.size >= maxDocuments) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) return;
    store.delete(oldestKey);
  }
}

function requireApiKey(apiKey) {
  if (!apiKey) throw httpError(503, "本地服务没有设置 OPENAI_API_KEY。", true);
}

function requireAccessToken(request, expected) {
  if (!expected) return;
  const received = request.headers["x-reader-token"] || "";
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(received));
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw httpError(401, "阅读器访问口令不正确。", true);
  }
}

function validateId(value, prefix) {
  const id = String(value || "");
  if (!new RegExp(`^${prefix}[-_][A-Za-z0-9_-]+$`).test(id)) {
    throw httpError(400, `${prefix} ID 无效。`, true);
  }
  return id;
}

function sanitizeFilename(value) {
  const filename = String(value).replace(/[\\/:*?"<>|\x00-\x1F]/g, "_").slice(0, 160) || "paper.pdf";
  return filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
}

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, "请求内容过大。", true));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "请求 JSON 格式无效。", true));
      }
    });
    request.on("error", reject);
  });
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
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function httpError(status, message, expose = false) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  return error;
}

export function startServer() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Codex Paper Reader server: http://${host}:${port}`);
    console.log(process.env.OPENAI_API_KEY ? "OpenAI API key: configured" : "OpenAI API key: MISSING");
    console.log(process.env.READER_ACCESS_TOKEN ? "Reader access token: required" : "Reader access token: not set (local use only)");
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
