import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

const javascriptFiles = [
  "extension/background.js",
  "extension/entry.js",
  "extension/markdown.js",
  "extension/test/markdown.test.js",
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

// 顶层 ZhangYu/AGENTS.md 要求每个独立 Repo 根目录都自带这两个文件：
// Codex 只从当前 Repo 根开始找 AGENTS.md，不会继续往上读。
for (const file of ["AGENTS.md", "CLAUDE.md"]) {
  if (!existsSync(resolve(root, file))) throw new Error(`${file} is missing from the repo root`);
}
if (!read("CLAUDE.md").includes("@AGENTS.md")) {
  throw new Error("CLAUDE.md must import @AGENTS.md instead of restating shared rules");
}
if (read("AGENTS.md").includes("CLAUDE.md")) {
  throw new Error("AGENTS.md must not depend on CLAUDE.md — the dependency only runs one way");
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
// 目录必须从实际写出的标题派生：章节结构跟着论文走，写死一份必然对不上。
if (!sidepanelJs.includes("sectionTitles") || !sidepanelJs.includes("summary-toc")) {
  throw new Error("The summary must carry a table of contents derived from its own headings");
}
// 大白话必须是引用块：渲染器要支持合并多行，prompt 要求行首的 > 不能省。
if (!read("extension/markdown.js").includes("closeQuote")) {
  throw new Error("Consecutive quote lines must merge into one blockquote");
}
// prompt 是反引号模板字符串。里面出现裸反引号会提前终止它，而偶数个反引号
// 还能重新配对成合法但语义错乱的代码——node --check 完全拦不住。
{
  const match = sidepanelJs.match(/const AUTO_SUMMARY_PROMPT = `([\s\S]*?)`;\n\nconst DEFAULT_SETTINGS/);
  if (!match) throw new Error("AUTO_SUMMARY_PROMPT is missing or its delimiters were broken");
  if (match[1].includes("`")) {
    throw new Error("AUTO_SUMMARY_PROMPT must not contain a backtick — it silently truncates the template literal");
  }
}
if (!sidepanelJs.includes("必须写成 Markdown 引用")) {
  throw new Error("The plain-language explanation must be emitted as a blockquote");
}
if (!read("extension/sidepanel.css").includes(".summary-toc")) {
  throw new Error("The table of contents is missing its styles");
}
if (!entryJs.includes("pointerdown") || !entryJs.includes("POSITION_KEY")) {
  throw new Error("The floating entry button must be draggable with a remembered position");
}
if (!backgroundJs.includes("chrome.tabs.create") || !backgroundJs.includes('type !== "OPEN_READER"')) {
  throw new Error("The extension action must open a PDF-bound reader tab");
}
if (!entryJs.includes("论文导读") || !entryJs.includes('a[href*="/pdf/"]')) {
  throw new Error("The arXiv/PDF page entry is missing");
}

for (const heading of ["## 一句话总结", "## 既有方案的痛点", "## 核心工作", "## 它是怎么做的",
                       "## 效果如何", "## 局限与存疑", "## 后续方向"]) {
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
  ["加粗的第一句就是这一条的论点", "each bullet must open with a bold claim sentence, not a label"],
  ["每条最多三句", "bullets must stay within three sentences so the summary scans"],
  // 硬字数会让模型写到一半就收手，留下没写完的阶段。完整性必须压过篇幅。
  ["写完整比写短重要", "finishing every section must outrank brevity"],
  ["绝不允许写到一半停下", "the walkthrough must never stop mid-structure"],
  // 效果那节是唯一该出数字的地方；局限那节必须分清论文自陈和读者推断。
  ["这一节是全文唯一鼓励给数字的地方", "the results section must be the one place numbers belong"],
  ["不能伪装成论文结论", "inferred limitations must never be passed off as the paper's own"],
  ["不要自己发明研究方向", "future work must come from the paper, never invented"],
  // 章节结构必须跟着论文走。写死模板会把数据引擎、评测基准这类主贡献整章漏掉。
  ["由这篇论文自己决定，不要套模板", "the walkthrough's subsections must adapt to the paper, not a fixed template"],
  ["很多论文的贡献根本不在模型结构上", "the prompt must not assume the contribution is a model architecture"],
  // 图表页原图本来就送进模型了；不指认编号，读者没法照着论文对读。
  ["如果论文有整体架构图或方法总览图", "the walkthrough must name the paper's main architecture figure"],
  ["只写你确实看到的编号", "figure numbers must never be invented"]
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
