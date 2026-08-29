import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const javascriptFiles = [
  "extension/background.js",
  "extension/entry.js",
  "extension/markdown.js",
  "extension/sidepanel.js",
  "server/server.js",
  "server/test/server.test.js",
  "scripts/package-extension.mjs"
];

for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", resolve(root, file)], { stdio: "inherit" });
}

const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("manifest.json must use Manifest V3");
if (manifest.side_panel) throw new Error("The reader must open as a dedicated tab, not a Side Panel");
if (!manifest.content_scripts?.some((entry) => entry.js?.includes("entry.js"))) {
  throw new Error("manifest.json is missing the GPT reader page entry script");
}

for (const relativePath of [manifest.background?.service_worker, "sidepanel.html", "entry.js"]) {
  if (!relativePath || !existsSync(resolve(root, "extension", relativePath))) {
    throw new Error(`Manifest entry does not exist: ${relativePath}`);
  }
}

const sidepanelHtml = readFileSync(resolve(root, "extension/sidepanel.html"), "utf8");
const sidepanelJs = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");
if (sidepanelHtml.includes("data-prompt=")) throw new Error("The automatic summary UI must not contain prompt-selection buttons");
if (!sidepanelJs.includes("AUTO_SUMMARY_PROMPT") || !sidepanelJs.includes("automatic: true")) {
  throw new Error("The side panel is missing automatic paper summarization");
}
if (!sidepanelJs.includes('/api/chat/stream') || !sidepanelJs.includes('event.type !== "delta"')) {
  throw new Error("The side panel is missing streamed paper responses");
}
if (sidepanelJs.includes("chrome.tabs.onActivated") || sidepanelJs.includes("GET_ACTIVE_DOCUMENT")) {
  throw new Error("The dedicated reader page must not follow the active browser tab");
}
const backgroundJs = readFileSync(resolve(root, "extension/background.js"), "utf8");
if (!backgroundJs.includes("chrome.tabs.create") || !backgroundJs.includes('type !== "OPEN_READER"')) {
  throw new Error("The extension action must open a PDF-bound reader tab");
}
const entryJs = readFileSync(resolve(root, "extension/entry.js"), "utf8");
if (!entryJs.includes("GPT 导读") || !entryJs.includes('a[href*="/pdf/"]')) {
  throw new Error("The arXiv/PDF page entry is missing");
}
for (const heading of [
  "## 一句话总结",
  "## 既有方案的痛点",
  "## 核心工作",
  "## 概念与算法流程"
]) {
  if (!sidepanelJs.includes(heading)) throw new Error(`The automatic summary prompt is missing: ${heading}`);
}
for (const groundingRule of ["论文未说明", "大白话（直觉解释）", "表格内部不要插入空行"]) {
  if (!sidepanelJs.includes(groundingRule)) throw new Error(`The automatic summary prompt is missing grounding rule: ${groundingRule}`);
}
if (!sidepanelJs.includes("值得追问的问题") || !sidepanelJs.includes("推荐问题")) {
  throw new Error("The automatic summary prompt must forbid suggested follow-up questions");
}
if (!sidepanelHtml.includes('type="module"') || !sidepanelJs.includes('from "./markdown.js"')) {
  throw new Error("The side panel is not using the tested Markdown renderer module");
}
const referencedIds = [...sidepanelJs.matchAll(/querySelector\("#([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]);
for (const id of referencedIds) {
  if (!sidepanelHtml.includes(`id="${id}"`)) throw new Error(`sidepanel.js references missing element #${id}`);
}

console.log(`Checked ${javascriptFiles.length} JavaScript files, ${referencedIds.length} UI bindings, and Manifest V3 metadata.`);
