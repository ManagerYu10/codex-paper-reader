import { escapeHtml, renderMarkdown } from "./markdown.js";

const AUTO_SUMMARY_PROMPT = `请完整阅读这篇论文，并生成一份适合快速理解方法的第一版结构化导读。

证据与防幻觉规则（优先级最高）：
- 只依据当前 PDF。回答前交叉核对摘要、引言、方法、实验和附录中与结论有关的内容，不要只凭摘要补全方法细节。
- 模型名称、数据规模、评价维度、模块结构、训练参数、损失函数和实验数值等精确信息，必须在句末标注可核验的位置，例如“（Sec. 4.2；Table 3）”或“（第 7 页；Fig. 2）”。位置无法确认时，写“论文未说明”或省略该细节，绝不按领域惯例猜测。
- 明确区分 **论文明确说明**、**直觉解释** 和 **从结果作出的推断**。类比只能帮助理解，不得伪装成论文事实。
- 特别复核容易混淆的概念：人工标签与派生指标、平均与拼接、冻结的原始权重与可训练适配器、独立任务与联合输出、训练流程与推理流程。
- 如果正文、公式和表格之间存在冲突，直接指出冲突，不擅自选择一个版本。
- 不生成“值得追问的问题”“延伸问题”“下一步建议”、推荐提问或邀请用户继续的结尾，只总结论文本身。

## 一句话总结
用一句话说明这项工作解决了什么问题、提出了什么方法，以及取得了什么核心效果。即使读者不熟悉该领域也应能看懂。

## 既有方案的痛点
从论文的摘要、引言和相关工作中识别作者要改进的既有方法，列出 3–6 个 bullet。每一点说明“具体痛点是什么”以及“为什么它会限制效果或应用”。不要把本论文自身的局限误写成既有方案的痛点；论文没有给出证据的内容不要自行补充。

## 核心工作
用 2–5 个 bullet 概括作者实际完成的核心工作。区分作者宣称的贡献与实验直接支持的结论，并尽可能标注对应章节、图表或页码；无法确认位置时不要编造引用。

## 概念与算法流程
使用下面的自适应结构，像给懂技术但第一次接触该论文的读者讲解：

### 整体思路
先用一个短段落解释输入、目标、核心思想和最终输出。

如果论文明确包含多个阶段，依次使用“### 阶段 1：名称”“### 阶段 2：名称”等三级标题，每个阶段用 3–7 个有序步骤说明输入、核心模块、数据流、更新了什么以及产出什么。如果论文没有明确分阶段，则使用“### 端到端流程”，用 4–8 个有序步骤讲清完整算法，不要人为编造阶段。

技术密集的阶段后可以补一句：
> **大白话（直觉解释）：** 用准确的类比说明这一阶段在做什么。

类比必须标为“直觉解释”，且不能引入论文没有的新机制。若论文涉及模型训练，再增加“### 训练与推理”，分别说明训练输入、监督信号、损失、可训练/冻结参数，以及推理时的输入和输出；若论文没有训练过程则省略该小节。

只有当某个公式对理解算法不可替代时才加入，最多 1–3 个，并紧接着解释每个变量、公式在流程中的作用，以及直觉含义；否则完全省略公式。

Markdown 格式要求：
- 必须使用上面的四个二级标题，不得省略章节标题；只有明确不适用的三级小节可以省略。
- 痛点和核心工作必须使用“- ”bullet；算法流程必须使用“1. ”有序步骤。
- 每个 bullet 开头用 **加粗关键词：** 概括该点，但不要整段加粗。
- 当论文比较多个方法、数据集或指标时，优先使用 GitHub 风格 Markdown 表格。表头、分隔行和数据行必须连续，表格内部不要插入空行，也不要放进代码块。例如：

| 方法 | 指标 | 证据位置 |
|---|---:|---|
| Baseline | 0.72 | Table 3 |
| 本文方法 | **0.78** | Table 3 |

- 普通解释使用短段落，避免连续的大段文字。
- 第一版导读控制在约 1,200–2,000 个汉字，保留理解方法所必需的信息，省略重复背景和次要实验罗列。

输出简体中文，专业名词首次出现时附英文。直接从“## 一句话总结”开始，不复述这些规则，不写寒暄、阅读过程、产品推荐、推荐问题或“是否继续”的结尾。`;

const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: "http://127.0.0.1:8787",
  accessToken: "",
  model: "gpt-5.6-luna",
  reasoningEffort: "none"
});

const SETTINGS_VERSION = 3;
const MAX_BROWSER_PDF_BYTES = 50 * 1024 * 1024;
const state = {
  settings: { ...DEFAULT_SETTINGS },
  document: null,
  documentKey: "",
  fileId: "",
  responseId: "",
  messages: [],
  busy: false,
  abortController: null
};

const elements = {
  pdfTitle: document.querySelector("#pdf-title"),
  pdfFrame: document.querySelector("#pdf-frame"),
  pdfEmpty: document.querySelector("#pdf-empty"),
  openOriginalButton: document.querySelector("#open-original-button"),
  paperTitle: document.querySelector("#paper-title"),
  documentStatus: document.querySelector("#document-status"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyCopy: document.querySelector("#empty-copy"),
  welcomeState: document.querySelector("#welcome-state"),
  chatList: document.querySelector("#chat-list"),
  input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  newSessionButton: document.querySelector("#new-session-button"),
  uploadProgress: document.querySelector("#upload-progress"),
  uploadProgressText: document.querySelector("#upload-progress-text"),
  modelBadge: document.querySelector("#model-badge"),
  settingsButton: document.querySelector("#settings-button"),
  settingsDialog: document.querySelector("#settings-dialog"),
  settingsForm: document.querySelector("#settings-form"),
  closeSettingsButton: document.querySelector("#close-settings-button"),
  backendUrl: document.querySelector("#backend-url"),
  accessToken: document.querySelector("#access-token"),
  modelSelect: document.querySelector("#model-select"),
  reasoningEffort: document.querySelector("#reasoning-effort"),
  connectionResult: document.querySelector("#connection-result"),
  testConnectionButton: document.querySelector("#test-connection-button"),
  messageTemplate: document.querySelector("#message-template")
};

let progressTimer = null;
let progressStartedAt = 0;
let progressBaseText = "";

void initialize();

async function initialize() {
  bindEvents();
  await loadSettings();
  await initializeBoundDocument();
}

function bindEvents() {
  elements.sendButton.addEventListener("click", () => void submitInput());
  elements.input.addEventListener("input", autoResizeInput);
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitInput();
    }
  });
  elements.newSessionButton.addEventListener("click", () => void clearSession());
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener("submit", (event) => void saveSettings(event));
  elements.testConnectionButton.addEventListener("click", () => void testConnection());
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("readerSettings");
  const previous = stored.readerSettings || {};
  state.settings = previous.settingsVersion === SETTINGS_VERSION
    ? { ...DEFAULT_SETTINGS, ...previous }
    : {
        ...DEFAULT_SETTINGS,
        backendUrl: previous.backendUrl || DEFAULT_SETTINGS.backendUrl,
        accessToken: previous.accessToken || "",
        settingsVersion: SETTINGS_VERSION
      };
  await chrome.storage.local.set({ readerSettings: state.settings });
  syncSettingsUi();
}

function syncSettingsUi() {
  elements.backendUrl.value = state.settings.backendUrl;
  elements.accessToken.value = state.settings.accessToken;
  elements.modelSelect.value = state.settings.model;
  elements.reasoningEffort.value = state.settings.reasoningEffort;
  elements.modelBadge.textContent = `${modelLabel(state.settings.model)} · ${reasoningLabel(state.settings.reasoningEffort)}`;
}

async function initializeBoundDocument() {
  setStatus("正在读取固定 PDF", "neutral");
  const params = new URLSearchParams(location.search);
  const pdfUrl = params.get("pdf") || "";
  if (!isSupportedDocumentUrl(pdfUrl)) {
    showNoDocument(
      "没有绑定可读取的 PDF",
      "请从 arXiv 的“GPT 导读”按钮、PDF 页面或扩展图标重新打开。"
    );
    return;
  }

  const title = params.get("title") || filenameFromUrl(pdfUrl);
  state.document = { url: pdfUrl, title };
  state.documentKey = await hashText(pdfUrl);
  state.fileId = "";
  state.responseId = "";
  state.messages = [];
  await loadSession();

  document.title = `${title} · GPT 导读`;
  elements.paperTitle.textContent = title;
  elements.pdfTitle.textContent = title;
  elements.pdfFrame.src = pdfUrl;
  elements.pdfFrame.hidden = false;
  elements.pdfEmpty.hidden = true;
  elements.openOriginalButton.href = pdfUrl;
  elements.emptyState.hidden = true;
  renderMessages();
  setStatus("已固定绑定当前 PDF", "ready");
  if (state.messages.length === 0) void sendMessage(AUTO_SUMMARY_PROMPT, { automatic: true });
}

function isSupportedDocumentUrl(rawUrl) {
  try {
    return ["http:", "https:", "file:"].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function showNoDocument(title, copy) {
  state.document = null;
  state.documentKey = "";
  state.fileId = "";
  state.responseId = "";
  state.messages = [];
  elements.paperTitle.textContent = "等待打开论文";
  elements.pdfTitle.textContent = "没有绑定 PDF";
  elements.pdfFrame.removeAttribute("src");
  elements.pdfFrame.hidden = true;
  elements.pdfEmpty.hidden = false;
  elements.openOriginalButton.removeAttribute("href");
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.emptyState.hidden = false;
  elements.welcomeState.hidden = true;
  elements.chatList.replaceChildren();
  setStatus("当前页面不是可读取的 PDF", "error");
}

async function submitInput() {
  const text = elements.input.value.trim();
  if (!text) return;
  elements.input.value = "";
  autoResizeInput();
  await sendMessage(text);
}

async function sendMessage(text, options = {}) {
  if (state.busy || !text) return;
  if (!state.document) {
    showNoDocument("请先打开一篇 PDF", "从 arXiv、PDF 页面或扩展图标打开固定的 GPT 导读页后再提问。");
    return;
  }

  state.busy = true;
  state.abortController = new AbortController();
  setBusyUi(true);
  state.messages.push({ role: "user", text, hidden: Boolean(options.automatic) });
  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", text: "", streaming: true };
  state.messages.push(assistantMessage);
  renderMessages();

  try {
    if (!state.fileId) await uploadCurrentDocument();
    setProgress(`${modelLabel(state.settings.model)} 正在解析全文，首段生成后会立即显示…`);
    setStatus("正在分析论文", "busy");

    let firstDelta = true;
    let renderFrame = 0;
    const response = await apiStreamRequest("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        fileId: state.fileId,
        previousResponseId: state.responseId || undefined,
        message: text,
        model: state.settings.model,
        reasoningEffort: state.settings.reasoningEffort,
        language: "zh-CN"
      }),
      signal: state.abortController.signal
    }, (event) => {
      if (event.type !== "delta") return;
      assistantMessage.text += event.delta;
      if (firstDelta) {
        firstDelta = false;
        setProgress(`${modelLabel(state.settings.model)} 正在实时生成导读…`);
      }
      if (!renderFrame) {
        renderFrame = requestAnimationFrame(() => {
          renderFrame = 0;
          updateAssistantMessage(assistantMessage);
        });
      }
    });

    state.responseId = response.responseId;
    assistantMessage.streaming = false;
    assistantMessage.text ||= "模型没有返回文字内容。";
    if (renderFrame) cancelAnimationFrame(renderFrame);
    updateAssistantMessage(assistantMessage);
    await saveSession();
    setStatus("已固定绑定当前 PDF", "ready");
  } catch (error) {
    assistantMessage.streaming = false;
    if (!assistantMessage.text.trim()) {
      state.messages = state.messages.filter((message) => message !== assistantMessage);
    } else {
      assistantMessage.text += "\n\n> **生成中断：** 以下内容可能不完整。";
    }
    const friendly = friendlyError(error);
    state.messages.push({ role: "error", text: friendly });
    setStatus("请求失败", "error");
  } finally {
    state.busy = false;
    state.abortController = null;
    setBusyUi(false);
    renderMessages();
  }
}

async function uploadCurrentDocument() {
  setProgress("正在下载并验证绑定的 PDF…");
  setStatus("正在准备论文", "busy");

  let response;
  try {
    response = await fetch(state.document.url, { credentials: "include", signal: state.abortController.signal });
  } catch (error) {
    if (state.document.url.startsWith("file:")) {
      throw new Error("无法读取本地 PDF。请到 chrome://extensions，打开本扩展详情并启用“允许访问文件网址”。");
    }
    throw new Error(`无法下载当前 PDF：${error.message}`);
  }

  if (!response.ok) throw new Error(`下载 PDF 失败（HTTP ${response.status}）。这篇论文可能需要登录。`);
  const blob = await response.blob();
  if (blob.size > MAX_BROWSER_PDF_BYTES) throw new Error("PDF 超过 50 MiB，当前版本暂不上传这么大的文件。");

  const signature = new TextDecoder("ascii").decode(await blob.slice(0, 5).arrayBuffer());
  if (signature !== "%PDF-") {
    throw new Error("当前地址返回的不是 PDF 文件。若网站使用了登录或跳转，请先下载 PDF，再从本地打开。");
  }

  setProgress(`正在上传 ${formatBytes(blob.size)} 到本地阅读服务…`);
  const pdfBase64 = await blobToBase64(blob);
  const result = await apiRequest("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      filename: `${safeFilename(state.document.title)}.pdf`,
      pdfBase64
    }),
    signal: state.abortController.signal
  });
  state.fileId = result.fileId;
  await saveSession();
}

async function apiRequest(path, options = {}) {
  const url = `${normalizeBackendUrl(state.settings.backendUrl)}${path}`;
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.settings.accessToken) headers["X-Reader-Token"] = state.settings.accessToken;

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    throw new Error(`连接不到本地服务 ${state.settings.backendUrl}。请先在项目目录运行 npm start。`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `本地服务返回 HTTP ${response.status}`);
  return body;
}

async function apiStreamRequest(path, options = {}, onEvent = () => {}) {
  const url = `${normalizeBackendUrl(state.settings.backendUrl)}${path}`;
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.settings.accessToken) headers["X-Reader-Token"] = state.settings.accessToken;

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`连接不到本地服务 ${state.settings.backendUrl}。请先在项目目录运行 npm start。`);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `本地服务返回 HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("浏览器没有收到可读取的流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error("本地服务返回了无法解析的流式数据。");
        }
        if (event.type === "error") throw new Error(event.error || "流式响应失败。");
        if (event.type === "done") completed = event;
        onEvent(event);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!completed?.responseId) throw new Error("流式响应在完成前意外结束。");
  return completed;
}

async function clearSession() {
  if (!state.documentKey || state.busy) return;
  if (state.messages.length && !confirm("清空这篇论文的对话并删除已上传的临时文件？")) return;

  const fileId = state.fileId;
  state.fileId = "";
  state.responseId = "";
  state.messages = [];
  await chrome.storage.local.remove(sessionStorageKey());
  renderMessages();
  setStatus("正在重新生成论文导读", "busy");

  if (fileId) {
    apiRequest("/api/documents/delete", {
      method: "POST",
      body: JSON.stringify({ fileId })
    }).catch(() => {});
  }
  void sendMessage(AUTO_SUMMARY_PROMPT, { automatic: true });
}

async function saveSession() {
  if (!state.documentKey) return;
  await chrome.storage.local.set({
    [sessionStorageKey()]: {
      url: state.document?.url,
      fileId: state.fileId,
      responseId: state.responseId,
      messages: state.messages.slice(-80),
      updatedAt: Date.now()
    }
  });
}

async function loadSession() {
  if (!state.documentKey) return;
  const key = sessionStorageKey();
  const stored = await chrome.storage.local.get(key);
  const session = stored[key];
  if (!session || session.url !== state.document.url) return;
  state.fileId = session.fileId || "";
  state.responseId = session.responseId || "";
  state.messages = Array.isArray(session.messages) ? session.messages : [];
}

function sessionStorageKey() {
  return `paperSession:${state.documentKey}`;
}

function renderMessages() {
  elements.chatList.replaceChildren();
  const visibleMessages = state.messages.filter((message) => !message.hidden);
  elements.welcomeState.hidden = !state.document || visibleMessages.length > 0;
  if (!visibleMessages.length) return;

  for (const message of visibleMessages) {
    message.id ||= crypto.randomUUID();
    const fragment = elements.messageTemplate.content.cloneNode(true);
    const article = fragment.querySelector(".message");
    const avatar = fragment.querySelector(".message-avatar");
    const author = fragment.querySelector(".message-author");
    const body = fragment.querySelector(".message-body");
    article.classList.add(`message-${message.role}`);
    article.dataset.messageId = message.id;

    if (message.role === "user") {
      avatar.textContent = "你";
      author.textContent = "你";
      body.textContent = message.text;
    } else if (message.role === "error") {
      avatar.textContent = "!";
      author.textContent = "请求未完成";
      body.textContent = message.text;
    } else {
      avatar.textContent = "C";
      author.textContent = modelLabel(state.settings.model);
      renderAssistantBody(body, message);
    }
    elements.chatList.append(fragment);
  }
  requestAnimationFrame(() => elements.chatList.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" }));
}

function updateAssistantMessage(message) {
  const article = [...elements.chatList.querySelectorAll(".message")]
    .find((candidate) => candidate.dataset.messageId === message.id);
  if (!article) return renderMessages();
  renderAssistantBody(article.querySelector(".message-body"), message);
  elements.chatList.lastElementChild?.scrollIntoView({ block: "end", behavior: "auto" });
}

function renderAssistantBody(body, message) {
  if (!message.text && message.streaming) {
    body.innerHTML = '<span class="streaming-placeholder">正在读取论文并准备导读…</span>';
    return;
  }
  body.innerHTML = renderMarkdown(message.text);
  if (message.streaming) body.insertAdjacentHTML("beforeend", '<span class="streaming-cursor" aria-label="正在生成"></span>');
}

function setBusyUi(busy) {
  elements.sendButton.disabled = busy;
  elements.input.disabled = busy;
  elements.uploadProgress.hidden = !busy;
  if (!busy && progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function setProgress(text) {
  progressBaseText = text;
  progressStartedAt = Date.now();
  updateProgressText();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(updateProgressText, 1000);
  elements.uploadProgress.hidden = false;
}

function updateProgressText() {
  const elapsedSeconds = Math.floor((Date.now() - progressStartedAt) / 1000);
  elements.uploadProgressText.textContent = elapsedSeconds > 0
    ? `${progressBaseText}（${elapsedSeconds}s）`
    : progressBaseText;
}

function setStatus(text, type) {
  elements.documentStatus.className = `status-pill status-${type}`;
  elements.documentStatus.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function autoResizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`;
}

function openSettings() {
  syncSettingsUi();
  elements.connectionResult.hidden = true;
  elements.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  state.settings = {
    backendUrl: normalizeBackendUrl(elements.backendUrl.value),
    accessToken: elements.accessToken.value.trim(),
    model: elements.modelSelect.value,
    reasoningEffort: elements.reasoningEffort.value,
    settingsVersion: SETTINGS_VERSION
  };
  await chrome.storage.local.set({ readerSettings: state.settings });
  syncSettingsUi();
  elements.settingsDialog.close();
  renderMessages();
}

async function testConnection() {
  const previousSettings = state.settings;
  state.settings = {
    ...state.settings,
    backendUrl: normalizeBackendUrl(elements.backendUrl.value),
    accessToken: elements.accessToken.value.trim()
  };
  elements.connectionResult.hidden = false;
  elements.connectionResult.className = "connection-result";
  elements.connectionResult.textContent = "正在连接…";

  try {
    const health = await apiRequest("/health", { method: "GET" });
    elements.connectionResult.classList.add(health.apiKeyConfigured ? "ok" : "error");
    elements.connectionResult.textContent = health.apiKeyConfigured
      ? `连接成功。默认模型：${health.defaultModel}`
      : "服务已启动，但没有检测到 OPENAI_API_KEY。";
  } catch (error) {
    elements.connectionResult.classList.add("error");
    elements.connectionResult.textContent = error.message;
  } finally {
    state.settings = previousSettings;
  }
}

function friendlyError(error) {
  if (error.name === "AbortError") return "请求已取消。";
  return error.message || "发生未知错误，请检查本地服务日志。";
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).trim().replace(/\/+$/, "");
}

function modelLabel(model) {
  if (model.endsWith("-terra")) return "GPT‑5.6 Terra";
  if (model.endsWith("-luna")) return "GPT‑5.6 Luna";
  return "GPT‑5.6";
}

function reasoningLabel(effort) {
  if (effort === "none") return "无推理";
  if (effort === "medium") return "中等推理";
  if (effort === "high") return "高推理";
  return "低推理";
}

function filenameFromUrl(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() || "未命名论文").replace(/\.pdf$/i, "");
  } catch {
    return "未命名论文";
  }
}

function safeFilename(value) {
  return String(value || "paper").replace(/[\\/:*?"<>|\x00-\x1F]/g, "_").slice(0, 120) || "paper";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取 PDF 内容失败。"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.readAsDataURL(blob);
  });
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
