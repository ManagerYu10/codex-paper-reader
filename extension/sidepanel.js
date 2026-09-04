import { escapeHtml, renderMarkdown } from "./markdown.js";

const AUTO_SUMMARY_PROMPT = `请完整阅读这篇论文，生成一份**速读导读**。

读者画像：他经常读论文，但没读过这一篇，也不熟悉这个子方向。他想用几分钟搞清楚三件事——这篇在跟什么麻烦较劲、为什么这个麻烦不好绕、这篇是怎么绕过去的。他不打算在第一遍就啃公式、系数和超参数。

可读性规则（这是本次任务的主要目标）：
- **要能扫读，也要能读懂。** 大量使用 bullet、加粗和表格，让读者一眼就能定位重点。但每条 bullet 必须是**能独立读懂的完整句子**，不是名词碎片——"**数据清洗：**多阶段过滤 + 去重 + 平衡"是碎片，"**先把训练数据筛干净。** 作者从约 40 亿张网络图片里逐层过滤，只留下约 10 亿张高质量人像"才是完整句子。
- **每条 bullet 用加粗开头点题。** 加粗的部分是这条在讲什么（一句短话或一个短语），后面跟完整解释。读者只看加粗就应该能串出主线。
- **先说人话，再给名字。** 论文自造的概念、缩写和指标，第一次出现时必须先用日常语言说清楚它到底指什么，然后才在括号里给出论文的叫法和英文缩写。例如"衡量一句提示词究竟给模型带进来多少画面信息（论文称 Grounded Perplexity Gain，GPG）"。此后可以直接用缩写。**绝不在解释之前先甩出缩写。**
- **不认识的缩写不要猜。** 只解释论文中明确写出全称或给过定义的缩写。论文里没有展开的缩写一律照抄原文，不要按字面推测它代表什么中文含义——把 DPO 猜成"差分隐私"这类错误比保留缩写严重得多。展不开就直接写"论文未说明该缩写的全称"。
- **少给数字。** 只有当一个数字本身就是结论时才写它，比如"提示越长效果反而越差"这类趋势里的关键对比。公式系数、相关系数、学习率、层数、参数量、消融表的逐项数值一律不进正文——读者想要时会自己追问。
- **同一个意思只说一遍。** 不要中文、英文、缩写三件套连着摆。
- **自检：** 把全文里所有括号、数字和英文缩写都盖住，读者应该仍然能复述这篇论文在做什么。做不到就重写。

证据与防幻觉规则（与可读性冲突时以本节为准）：
- 只依据当前 PDF。下结论前交叉核对摘要、引言、方法、实验和附录，不要只凭摘要补全方法细节。
- 正文中凡是出现具体数字、具体做法或容易被质疑的事实，在该句末尾附一次简短位置，例如"（第 7 页）"或"（Table 3）"。**一个段落最多附一次，不要每句都附。**"## 一句话总结"和"## 既有方案的痛点"里不附位置。
- 位置无法确认时，写"论文未说明"或直接省略该细节，绝不按领域惯例猜测模型版本、模块结构、超参数或数据规模。
- 明确区分 **论文明确说明**、**直觉解释** 和 **从结果作出的推断**。类比只用来帮助理解，不得伪装成论文事实。
- 特别复核容易混淆的概念：人工标签与派生指标、平均与拼接、冻结的原始权重与可训练适配器、独立任务与联合输出、训练流程与推理流程。
- 正文、公式和表格互相冲突时直接指出冲突，不要擅自挑一个版本。
- 不生成"值得追问的问题""延伸问题""下一步建议"、推荐问题或邀请用户继续提问的结尾，只总结论文本身。

## 一句话总结
两句话以内，说清楚这篇论文在解决什么麻烦、大致靠什么办法解决。**整节不出现任何括号：不写论文自造的名词、不写英文缩写、不写数字、不写"（第 N 页）"这类位置标注。** 一个不熟悉这个子方向的人读完应该能用自己的话复述出来。

## 既有方案的痛点
3–5 条 bullet，每条**加粗开头点出这是什么麻烦**，后面用 1–3 句完整的话讲清楚：以前大家怎么做、卡在哪里、为什么这个卡点不容易绕过去。目标是让人觉得"这确实是个麻烦"，而不是罗列缺点标签。不要把本论文自身的局限误写成既有方案的痛点，也不要补充论文没有给出证据的内容。

## 核心工作
2–4 条 bullet，每条**加粗开头一句话说清这一步在干什么**，后面补 1–2 句：具体怎么做的，以及它为什么能解开上面对应的痛点。区分作者宣称的贡献和实验真正支持的结论。

## 概念与算法流程
### 整体思路
一段话讲清楚：喂进去什么、想得到什么、靠哪个关键想法把两者连起来、最后吐出什么。

如果论文明确分成多个阶段，依次用"### 阶段 1：名称""### 阶段 2：名称"。**每个阶段先给直觉，再给步骤**，顺序不能颠倒：

> **大白话（直觉解释）：** 用一个准确的类比说明这一阶段在做什么。

然后用 3–6 个有序步骤说明这一阶段的输入、关键动作和产出。如果论文没有明确分阶段，就用"### 端到端流程"，用 4–8 个有序步骤讲完整条算法，不要人为编造阶段。

类比必须标成"直觉解释"，且不能引入论文里没有的新机制。如果论文涉及模型训练，再加一节"### 训练与推理"，说明训练时喂什么、监督信号来自哪里、哪些参数在动哪些冻着，以及推理时的输入和输出；论文没有训练过程就省略这一节。

公式默认不写。只有当某个公式本身就是这篇论文的核心贡献、不看它就无法理解方法时才写，最多 1 个，并且必须先用一句话说清它想表达的直觉，再解释变量。

Markdown 格式要求：
- 必须使用上面四个二级标题，不得省略；只有明确不适用的三级小节可以省略。
- 痛点和核心工作使用"- "bullet，算法流程使用"1. "有序步骤，两者都以加粗短语开头点题。
- 加粗只用来标记**这一条在讲什么**和**关键结论**，不要整句整段加粗，也不要拿加粗去强调数字。
- 能用表格表达的就用表格：多个方法/数据集/指标的横向对比、模型的几档规格、各阶段的输入与产出，都比连续 bullet 更好扫。
- 论文横向比较多个方法、数据集或指标时，用 GitHub 风格 Markdown 表格。表头、分隔行和数据行必须连续，表格内部不要插入空行，也不要放进代码块。例如：

| 方法 | 指标 | 证据位置 |
|---|---:|---|
| Baseline | 0.72 | Table 3 |
| 本文方法 | **0.78** | Table 3 |

- 全文控制在约 1,200–1,800 个汉字。宁可少讲一个次要实验，也不要牺牲可读性。

输出简体中文。直接从"## 一句话总结"开始，不复述这些规则，不写寒暄、阅读过程、产品推荐、推荐问题或"是否继续"的结尾。`;

const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: "http://127.0.0.1:8787",
  accessToken: ""
});

const SETTINGS_VERSION = 4;
const MAX_PDF_BYTES = 120 * 1024 * 1024;
const NEAR_BOTTOM_PX = 120;
const MAX_HISTORY_TURNS = 24;   // 与服务端 sanitizeHistory 保持一致
// 旧版链路存下来的会话恢复出来会挡住重新生成，直接作废。
const SESSION_SCHEMA = 2;
const REQUIRED_PROTOCOL = 2;   // 必须与 server.js 的 PROTOCOL_VERSION 一致

const state = {
  settings: { ...DEFAULT_SETTINGS },
  document: null,       // { url, title, file? }
  documentKey: "",
  fileId: "",
  facts: null,          // 服务端回报的解析实据
  messages: [],
  busy: false,
  abortController: null,
  stickToBottom: true,
  serverProtocol: null,
  handshake: null
};

const elements = {
  pdfTitle: document.querySelector("#pdf-title"),
  pdfFrame: document.querySelector("#pdf-frame"),
  pdfEmpty: document.querySelector("#pdf-empty"),
  openOriginalButton: document.querySelector("#open-original-button"),
  paperTitle: document.querySelector("#paper-title"),
  documentStatus: document.querySelector("#document-status"),
  docFacts: document.querySelector("#doc-facts"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyCopy: document.querySelector("#empty-copy"),
  pickFileButton: document.querySelector("#pick-file-button"),
  filePicker: document.querySelector("#file-picker"),
  welcomeState: document.querySelector("#welcome-state"),
  chatList: document.querySelector("#chat-list"),
  input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  stopButton: document.querySelector("#stop-button"),
  newSessionButton: document.querySelector("#new-session-button"),
  uploadProgress: document.querySelector("#upload-progress"),
  uploadProgressText: document.querySelector("#upload-progress-text"),
  modelBadge: document.querySelector("#model-badge"),
  activeModel: document.querySelector("#active-model"),
  settingsButton: document.querySelector("#settings-button"),
  settingsDialog: document.querySelector("#settings-dialog"),
  settingsForm: document.querySelector("#settings-form"),
  closeSettingsButton: document.querySelector("#close-settings-button"),
  backendUrl: document.querySelector("#backend-url"),
  accessToken: document.querySelector("#access-token"),
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
  // 不 await，避免拖慢首屏；但上传前一定会等它落定，见 assertServerProtocol
  state.handshake = syncModelBadge();
  await initializeBoundDocument();
}

function bindEvents() {
  elements.sendButton.addEventListener("click", () => void submitInput());
  elements.stopButton.addEventListener("click", stopGeneration);
  elements.input.addEventListener("input", autoResizeInput);
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitInput();
    }
  });
  // 用户往上翻就别再把他拽回底部，只有贴着底时才跟随流式输出。
  elements.chatList.addEventListener("scroll", () => {
    const distance = elements.chatList.scrollHeight - elements.chatList.scrollTop - elements.chatList.clientHeight;
    state.stickToBottom = distance <= NEAR_BOTTOM_PX;
  }, { passive: true });
  elements.newSessionButton.addEventListener("click", () => void clearSession());
  elements.pickFileButton.addEventListener("click", () => elements.filePicker.click());
  elements.filePicker.addEventListener("change", () => void useLocalFile(elements.filePicker.files?.[0]));
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener("submit", (event) => void saveSettings(event));
  elements.testConnectionButton.addEventListener("click", () => void testConnection());
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("readerSettings");
  const previous = stored.readerSettings || {};
  state.settings = {
    ...DEFAULT_SETTINGS,
    backendUrl: previous.backendUrl || DEFAULT_SETTINGS.backendUrl,
    accessToken: previous.accessToken || "",
    settingsVersion: SETTINGS_VERSION
  };
  await chrome.storage.local.set({ readerSettings: state.settings });
  syncSettingsUi();
}

/** 开机对一次 /health：核对协议版本，并让徽章显示服务端真正在用的模型。 */
async function syncModelBadge() {
  let health;
  try {
    health = await apiRequest("/health", { method: "GET" });
  } catch {
    return;   // 服务没起来不在这里报错，真正发问时会给出可操作的提示
  }
  state.serverProtocol = health.protocol ?? 1;
  if (health.model) {
    elements.modelBadge.textContent = modelLabel(health.model);
    elements.activeModel.textContent = health.model;
  }
}

/** 新扩展配旧服务会报出一堆无从下手的错，这里提前拦住并说清楚怎么办。 */
async function assertServerProtocol() {
  // 必须等握手落定，否则会和首次上传抢跑，漏判成旧服务的那堆怪错
  await state.handshake?.catch(() => {});
  if (state.serverProtocol === null || state.serverProtocol >= REQUIRED_PROTOCOL) return;
  throw new Error(
    "本地服务是旧版本，和当前扩展对不上。请到项目目录停掉再重新运行：\n" +
    "set -a && . ~/ZhangYu/.env && set +a && npm start"
  );
}

function syncSettingsUi() {
  elements.backendUrl.value = state.settings.backendUrl;
  elements.accessToken.value = state.settings.accessToken;
}

async function initializeBoundDocument() {
  setStatus("正在读取固定 PDF", "neutral");
  const params = new URLSearchParams(location.search);
  const pdfUrl = params.get("pdf") || "";
  if (!isSupportedDocumentUrl(pdfUrl)) {
    showNoDocument("没有绑定可读取的 PDF", "可以直接选择一份本地 PDF，或从 arXiv、PDF 页面重新打开。");
    return;
  }

  const title = params.get("title") || filenameFromUrl(pdfUrl);
  state.document = { url: pdfUrl, title };
  state.documentKey = await hashText(pdfUrl);
  await loadSession();

  applyTitle(state.document.title);
  elements.pdfFrame.src = pdfUrl;
  elements.pdfFrame.hidden = false;
  elements.pdfEmpty.hidden = true;
  elements.openOriginalButton.href = pdfUrl;
  elements.emptyState.hidden = true;
  renderMessages();
  renderFacts();
  setStatus("已固定绑定当前 PDF", "ready");
  if (state.messages.length === 0) void sendMessage(AUTO_SUMMARY_PROMPT, { automatic: true });
}

function applyTitle(title) {
  document.title = `${title} · 论文导读`;
  elements.paperTitle.textContent = title;
  elements.pdfTitle.textContent = title;
}

/** 从 URL 或标签页猜来的名字不算真标题，只有 PDF 里抽出来的才算。 */
function isRealTitle(title) {
  const value = String(title || "").trim();
  if (value.length <= 4) return false;
  return !/^(未命名论文|arXiv[\s:]|\d{4}\.\d{4,5}(v\d+)?$)/i.test(value);
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
  state.facts = null;
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
  elements.docFacts.hidden = true;
  elements.chatList.replaceChildren();
  setStatus("当前页面不是可读取的 PDF", "error");
}

/** 下载失败时的兜底：直接让用户交一份本地 PDF。 */
async function useLocalFile(file) {
  if (!file) return;
  const title = file.name.replace(/\.pdf$/i, "");
  state.document = { url: file.name, title, file };
  state.documentKey = await hashText(`local:${file.name}:${file.size}`);
  state.fileId = "";
  state.facts = null;
  state.messages = [];
  applyTitle(title);
  elements.emptyState.hidden = true;
  elements.pdfFrame.src = URL.createObjectURL(file);
  elements.pdfFrame.hidden = false;
  elements.pdfEmpty.hidden = true;
  setStatus("已载入本地 PDF", "ready");
  void sendMessage(AUTO_SUMMARY_PROMPT, { automatic: true });
}

async function submitInput() {
  const text = elements.input.value.trim();
  if (!text || state.busy) return;
  elements.input.value = "";
  autoResizeInput();
  await sendMessage(text);
}

function stopGeneration() {
  state.abortController?.abort();
}

async function sendMessage(text, options = {}) {
  if (state.busy || !text) return;
  if (!state.document) {
    showNoDocument("请先打开一篇 PDF", "从 arXiv、PDF 页面、扩展图标打开，或直接选择本地 PDF。");
    return;
  }

  state.busy = true;
  state.abortController = new AbortController();
  state.stickToBottom = true;
  setBusyUi(true);

  const history = buildHistory();
  state.messages.push({ role: "user", text, hidden: Boolean(options.automatic) });
  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", text: "", streaming: true };
  state.messages.push(assistantMessage);
  renderMessages();

  try {
    const response = await streamAnswer(text, history, assistantMessage);
    assistantMessage.streaming = false;
    assistantMessage.text ||= "模型没有返回文字内容。";
    if (response.truncated) assistantMessage.text += "\n\n> **已到长度上限：** 这一段被截断了，可以追问让它继续。";
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
    if (error.name !== "AbortError") state.messages.push({ role: "error", text: friendlyError(error) });
    setStatus(error.name === "AbortError" ? "已停止生成" : "请求失败", error.name === "AbortError" ? "ready" : "error");
  } finally {
    state.busy = false;
    state.abortController = null;
    setBusyUi(false);
    renderMessages();
  }
}

/** 论文缓存掉了就静默重传一次，不要求用户点“重新总结”。 */
async function streamAnswer(text, history, assistantMessage) {
  if (!state.fileId) await uploadCurrentDocument();
  try {
    return await requestStream(text, history, assistantMessage);
  } catch (error) {
    if (error.status !== 404 || state.abortController?.signal.aborted) throw error;
    state.fileId = "";
    assistantMessage.text = "";
    await uploadCurrentDocument();
    return await requestStream(text, history, assistantMessage);
  }
}

async function requestStream(text, history, assistantMessage) {
  setProgress("DeepSeek 正在读全文和图表页，首段生成后立即显示…");
  setStatus("正在分析论文", "busy");

  let firstDelta = true;
  let renderFrame = 0;
  const response = await apiStreamRequest("/api/chat/stream", {
    method: "POST",
    body: JSON.stringify({ fileId: state.fileId, message: text, history, language: "zh-CN" }),
    signal: state.abortController.signal
  }, (event) => {
    if (event.type !== "delta") return;
    assistantMessage.text += event.delta;
    if (firstDelta) {
      firstDelta = false;
      setProgress("DeepSeek 正在实时生成导读…");
    }
    if (!renderFrame) {
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        updateAssistantMessage(assistantMessage);
      });
    }
  });
  if (renderFrame) cancelAnimationFrame(renderFrame);
  return response;
}

function buildHistory() {
  return state.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.text }))
    .filter((turn) => turn.content.trim())
    .slice(-MAX_HISTORY_TURNS);
}

async function uploadCurrentDocument() {
  await assertServerProtocol();
  // 优先让本地服务自己去取：浏览器就不用为了喂模型再整份下载一遍。
  // 只有服务端拿不到（要登录、被挡）时才退回浏览器，用你的 cookie 下。
  const result = state.document.file
    ? await uploadBytes(state.document.file)
    : await uploadByUrl().catch(async (error) => {
        if (error.name === "AbortError") throw error;
        return uploadBytes(await downloadBoundPdf(error));
      });

  state.fileId = result.fileId;
  state.facts = result;
  if (isRealTitle(result.title)) {
    state.document.title = result.title;
    applyTitle(result.title);
  }
  renderFacts();
  await saveSession();
}

function uploadByUrl() {
  setProgress("本地服务正在取回并解析 PDF…");
  setStatus("正在解析论文", "busy");
  return apiRequest("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: state.document.url }),
    signal: state.abortController.signal
  });
}

async function uploadBytes(blob) {
  if (blob.size > MAX_PDF_BYTES) throw new Error(`PDF 超过 ${MAX_PDF_BYTES / 1024 / 1024} MiB，暂不支持。`);

  const signature = new TextDecoder("ascii").decode(await blob.slice(0, 5).arrayBuffer());
  if (signature !== "%PDF-") {
    throw new Error("当前地址返回的不是 PDF 文件。若网站需要登录或有人机验证，请先下载 PDF，再用“改为选择本地 PDF”。");
  }

  setProgress(`正在本地解析 ${formatBytes(blob.size)} 的 PDF（抽全文 + 渲染图表页）…`);
  setStatus("正在解析论文", "busy");
  // 直接发二进制，不做 base64，省掉 1.33 倍膨胀和一次全量编码。
  return apiRequest("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: blob,
    signal: state.abortController.signal
  });
}

async function downloadBoundPdf(serverError) {
  setProgress("本地服务取不到，改用浏览器凭据下载…");
  setStatus("正在准备论文", "busy");
  let lastError;
  // 带 cookie 拿不到时再试一次匿名请求：不少站点对扩展来源的带凭据请求会 403。
  for (const credentials of ["include", "omit"]) {
    try {
      const response = await fetch(state.document.url, { credentials, signal: state.abortController.signal });
      if (response.ok) return await response.blob();
      lastError = new Error(`下载 PDF 失败（HTTP ${response.status}）。`);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  if (state.document.url.startsWith("file:")) {
    throw new Error("无法读取本地 PDF。到 chrome://extensions 打开本扩展详情并启用“允许访问文件网址”，或直接用“改为选择本地 PDF”。");
  }
  throw new Error(`${lastError?.message || serverError?.message || "无法下载当前 PDF"}这篇可能需要登录，可改用“改为选择本地 PDF”。`);
}

function renderFacts() {
  const facts = state.facts;
  if (!facts) {
    elements.docFacts.hidden = true;
    return;
  }
  const parts = [`${facts.pages} 页`, `${formatCount(facts.chars)} 字符`];
  if (facts.imageCount) parts.push(`${facts.imageCount} 张图表页`);
  if (facts.scanned) parts.push("扫描件·纯视觉");
  elements.docFacts.textContent = `已送入模型：${parts.join(" · ")}`;
  elements.docFacts.title = facts.figurePages?.length ? `图表页：第 ${facts.figurePages.join("、")} 页` : "";
  elements.docFacts.hidden = false;
}

async function apiRequest(path, options = {}) {
  const url = `${normalizeBackendUrl(state.settings.backendUrl)}${path}`;
  const headers = { ...(options.headers || {}) };
  if (state.settings.accessToken) headers["X-Reader-Token"] = state.settings.accessToken;

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`连接不到本地服务 ${state.settings.backendUrl}。请先在项目目录运行 npm start。`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw withStatus(new Error(body.error || `本地服务返回 HTTP ${response.status}`), response.status);
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
    throw withStatus(new Error(body.error || `本地服务返回 HTTP ${response.status}`), response.status);
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

  if (!completed) throw new Error("流式响应在完成前意外结束。");
  return completed;
}

function withStatus(error, status) {
  error.status = status;
  return error;
}

async function clearSession() {
  if (!state.documentKey || state.busy) return;
  if (state.messages.length && !confirm("清空这篇论文的对话并重新解析原文？")) return;

  const fileId = state.fileId;
  state.fileId = "";
  state.facts = null;
  state.messages = [];
  await chrome.storage.local.remove(sessionStorageKey());
  renderMessages();
  renderFacts();
  setStatus("正在重新生成论文导读", "busy");

  if (fileId) {
    apiRequest("/api/documents/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId }) }).catch(() => {});
  }
  void sendMessage(AUTO_SUMMARY_PROMPT, { automatic: true });
}

async function saveSession() {
  if (!state.documentKey) return;
  await chrome.storage.local.set({
    [sessionStorageKey()]: {
      schema: SESSION_SCHEMA,
      url: state.document?.url,
      fileId: state.fileId,
      facts: state.facts,
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
  if (session.schema !== SESSION_SCHEMA) {
    await chrome.storage.local.remove(key);
    return;
  }
  state.fileId = session.fileId || "";
  state.facts = session.facts || null;
  state.messages = sanitizeRestoredMessages(session.messages);
  // 上一轮已经解析出真标题就直接沿用；恢复会话不会重新上传，
  // 不在这里取回来的话标题会一直停在从 URL 猜的占位符上。
  if (state.document && isRealTitle(state.facts?.title)) state.document.title = state.facts.title;
}

/**
 * 上传成功但生成中断时，会话里会留下一条空的 streaming 助手消息。
 * 原样恢复的话它会永远显示成正在生成，还会因为 messages 非空挡掉自动导读。
 */
function sanitizeRestoredMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const kept = messages.filter((message) =>
    message?.role !== "error" && !message?.streaming &&
    (message?.role !== "assistant" || String(message.text || "").trim()));
  // 助手一条都没答上来，就当这轮没发生过，让自动导读重新跑。
  return kept.some((message) => message.role === "assistant") ? kept : [];
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
      avatar.textContent = "D";
      author.textContent = elements.modelBadge.textContent || "DeepSeek";
      renderAssistantBody(body, message);
    }
    elements.chatList.append(fragment);
  }
  scrollToBottomIfPinned("smooth");
}

function updateAssistantMessage(message) {
  const article = [...elements.chatList.querySelectorAll(".message")]
    .find((candidate) => candidate.dataset.messageId === message.id);
  if (!article) return renderMessages();
  renderAssistantBody(article.querySelector(".message-body"), message);
  scrollToBottomIfPinned("auto");
}

function scrollToBottomIfPinned(behavior) {
  if (!state.stickToBottom) return;
  requestAnimationFrame(() => {
    elements.chatList.scrollTo({ top: elements.chatList.scrollHeight, behavior });
  });
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
  elements.sendButton.hidden = busy;
  elements.stopButton.hidden = !busy;
  elements.newSessionButton.disabled = busy;
  // 输入框保持可用：等生成的时候可以先把下一个问题打好。
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
    settingsVersion: SETTINGS_VERSION
  };
  await chrome.storage.local.set({ readerSettings: state.settings });
  syncSettingsUi();
  elements.settingsDialog.close();
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
      ? `连接成功。模型：${health.model}`
      : "服务已启动，但没有检测到 DEEPSEEK_API_KEY。";
    if (health.model) {
      elements.activeModel.textContent = health.model;
      elements.modelBadge.textContent = modelLabel(health.model);
    }
  } catch (error) {
    elements.connectionResult.classList.add("error");
    elements.connectionResult.textContent = error.message;
  } finally {
    state.settings = previousSettings;
  }
}

function modelLabel(model) {
  if (model.includes("vision")) return "DeepSeek V4 Flash Vision";
  if (model.includes("pro")) return "DeepSeek V4 Pro";
  return model;
}

function friendlyError(error) {
  if (error.name === "AbortError") return "请求已取消。";
  return error.message || "发生未知错误，请检查本地服务日志。";
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).trim().replace(/\/+$/, "");
}

function filenameFromUrl(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() || "未命名论文").replace(/\.pdf$/i, "");
  } catch {
    return "未命名论文";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatCount(value) {
  const number = Number(value) || 0;
  return number >= 10000 ? `${(number / 10000).toFixed(1)} 万` : String(number);
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
