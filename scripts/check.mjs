import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

const javascriptFiles = [
  "extension/background.js",
  "extension/entry.js",
  "extension/markdown.js",
  "extension/sidepanel.js",
  "server/server.js",
  "server/pdf-cache.js",
  "server/test/server.test.js",
  "server/test/pdf-cache.test.js",
  "extension/test/reader.test.js",
  "extension/test/entry.test.js",
  "extension/test/harness/dom.mjs",
  "scripts/package-extension.mjs"
];

for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", resolve(root, file)], { stdio: "inherit" });
}

const manifest = JSON.parse(read("extension/manifest.json"));
if (manifest.manifest_version !== 3) throw new Error("manifest.json must use Manifest V3");
if (manifest.side_panel) throw new Error("The reader must open as a dedicated tab, not a Side Panel");
if (!manifest.content_scripts?.some((entry) => entry.js?.includes("entry.js"))) {
  throw new Error("manifest.json is missing the reader page entry script");
}
for (const relativePath of [manifest.background?.service_worker, "sidepanel.html", "entry.js"]) {
  if (!relativePath || !existsSync(resolve(root, "extension", relativePath))) {
    throw new Error(`Manifest entry does not exist: ${relativePath}`);
  }
}

const sidepanelHtml = read("extension/sidepanel.html");
const sidepanelJs = read("extension/sidepanel.js");
const serverJs = read("server/server.js");
const entryJs = read("extension/entry.js");
const backgroundJs = read("extension/background.js");

// 论文必须先在本机解析，再以文本 + 图表页原图送进模型。
if (!existsSync(resolve(root, "server/extract.py"))) throw new Error("server/extract.py is missing");
const extractPy = read("server/extract.py");
for (const marker of ["import fitz", "===== PAGE", "get_pixmap"]) {
  if (!extractPy.includes(marker)) throw new Error(`server/extract.py is missing: ${marker}`);
}
if (!serverJs.includes("DEEPSEEK_API_KEY") || !serverJs.includes("/chat/completions")) {
  throw new Error("The local server must call DeepSeek chat completions");
}
if (!serverJs.includes("image_url")) throw new Error("The local server must send rendered figure pages as images");
// 别再回到「模型没拿到论文却一路绿灯」那种失败模式。
if (!serverJs.includes("assertReadable")) throw new Error("The server must verify the paper was actually parsed");
// 上游一次 402 曾经打死整个本地服务：async 处理器里 return 了没 await 的 promise。
if (!serverJs.includes("return await streamChat")) {
  throw new Error("streamChat must be awaited, or upstream errors escape the handler and kill the process");
}
if (!serverJs.includes("installProcessGuards") || !serverJs.includes("unhandledRejection")) {
  throw new Error("The local server must survive unhandled rejections instead of exiting");
}
// 反复读同一篇论文时整段下载都该省掉；缓存丢了就等于每次重下。
if (!serverJs.includes("readCached") || !serverJs.includes("writeCached")) {
  throw new Error("Downloaded PDFs must be cached on disk so re-reading a paper skips the download");
}
if (!existsSync(resolve(root, "server/pdf-cache.js"))) throw new Error("server/pdf-cache.js is missing");
if (!read(".gitignore").includes(".cache/")) throw new Error(".gitignore must exclude the PDF cache");
if (!serverJs.includes("RETRYABLE_STATUS")) {
  throw new Error("Transient upstream failures (429/5xx) must be retried with backoff");
}
if (!serverJs.includes("response.headersSent")) {
  throw new Error("An error after streaming started must not crash on writeHead");
}
for (const file of [["server/server.js", serverJs], ["extension/sidepanel.js", sidepanelJs], ["extension/sidepanel.html", sidepanelHtml]]) {
  if (/gpt-5\.6|openai|OPENAI_API_KEY|previous_response_id/i.test(file[1])) {
    throw new Error(`${file[0]} still references the retired OpenAI path`);
  }
}

if (!sidepanelJs.includes("AUTO_SUMMARY_PROMPT") || !sidepanelJs.includes("automatic: true")) {
  throw new Error("The reader is missing automatic paper summarization");
}
if (!sidepanelJs.includes("/api/chat/stream") || !sidepanelJs.includes('event.type !== "delta"')) {
  throw new Error("The reader is missing streamed paper responses");
}
if (sidepanelJs.includes("chrome.tabs.onActivated") || sidepanelJs.includes("GET_ACTIVE_DOCUMENT")) {
  throw new Error("The dedicated reader page must not follow the active browser tab");
}
// 三个体验回归的守卫
if (!sidepanelJs.includes("stickToBottom")) throw new Error("Streaming must not yank the user back to the bottom");
if (!sidepanelHtml.includes('id="stop-button"') || !sidepanelJs.includes("stopGeneration")) {
  throw new Error("The reader must offer a stop control while generating");
}
if (!sidepanelJs.includes("error.status !== 404")) {
  throw new Error("A dropped document cache must re-upload automatically");
}
if (!sidepanelHtml.includes('id="file-picker"')) throw new Error("The reader needs a local-PDF fallback");
if (!entryJs.includes("pointerdown") || !entryJs.includes("POSITION_KEY")) {
  throw new Error("The floating entry button must be draggable with a remembered position");
}
if (!backgroundJs.includes("chrome.tabs.create") || !backgroundJs.includes('type !== "OPEN_READER"')) {
  throw new Error("The extension action must open a PDF-bound reader tab");
}
if (!entryJs.includes("论文导读") || !entryJs.includes('a[href*="/pdf/"]')) {
  throw new Error("The arXiv/PDF page entry is missing");
}

for (const heading of ["## 一句话总结", "## 既有方案的痛点", "## 核心工作", "## 概念与算法流程"]) {
  if (!sidepanelJs.includes(heading)) throw new Error(`The automatic summary prompt is missing: ${heading}`);
}
for (const groundingRule of ["论文未说明", "大白话（直觉解释）", "表格内部不要插入空行"]) {
  if (!sidepanelJs.includes(groundingRule)) throw new Error(`The automatic summary prompt is missing grounding rule: ${groundingRule}`);
}
if (!sidepanelJs.includes("值得追问的问题") || !sidepanelJs.includes("推荐问题")) {
  throw new Error("The automatic summary prompt must forbid suggested follow-up questions");
}
// 速读导读的可读性规则。少了任何一条，输出就会退回被数字和锚点淹没的那种读感。
for (const readabilityRule of [
  ["先说人话，再给名字", "coined terms must be explained before they are named"],
  ["不认识的缩写不要猜", "unexpanded acronyms must be copied, never guessed at"],
  ["少给数字", "precise numbers must stay out of the narrative"],
  ["整节不出现任何括号", "the one-line summary must carry no parentheses"],
  ["一个段落最多附一次", "location anchors must not interrupt every sentence"],
  // 可扫读和可读懂是两件事，两条都要在：只有散文会淹没重点，只有词条会丢掉论证。
  ["要能扫读，也要能读懂", "the summary must stay scannable with bullets, bold and tables"],
  ["每条 bullet 用加粗开头点题", "bullets must lead with a bold phrase so the eye can land"]
]) {
  if (!sidepanelJs.includes(readabilityRule[0])) {
    throw new Error(`The automatic summary prompt is missing a readability rule: ${readabilityRule[1]}`);
  }
}
if (!sidepanelHtml.includes('type="module"') || !sidepanelJs.includes('from "./markdown.js"')) {
  throw new Error("The reader is not using the tested Markdown renderer module");
}

// docs/prompt.md 是派生文件；漂移了就等于仓库里躺着一份过时的 prompt。
{
  const { renderPromptDoc } = await import("./sync-prompt.mjs");
  if (read("docs/prompt.md") !== renderPromptDoc()) {
    throw new Error("docs/prompt.md is stale — run: npm run sync:prompt");
  }
}

const referencedIds = [...sidepanelJs.matchAll(/querySelector\("#([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]);
for (const id of referencedIds) {
  if (!sidepanelHtml.includes(`id="${id}"`)) throw new Error(`sidepanel.js references missing element #${id}`);
}

console.log(`Checked ${javascriptFiles.length} JavaScript files, ${referencedIds.length} UI bindings, the PDF extractor, and Manifest V3 metadata.`);
