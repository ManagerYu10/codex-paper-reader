// docs/prompt.md 是从 sidepanel.js 派生的，不是第二份事实来源。
// 直接改 docs/prompt.md 不会生效——改 sidepanel.js 里的 AUTO_SUMMARY_PROMPT，再跑 npm run sync:prompt。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const HEADER = `<!-- 由 scripts/sync-prompt.mjs 生成，请勿直接编辑 -->
# 自动导读 Prompt

阅读页打开论文后自动发出的第一条消息，逐字如下。唯一事实来源是
\`extension/sidepanel.js\` 里的 \`AUTO_SUMMARY_PROMPT\`；改完请运行 \`npm run sync:prompt\`。

---

`;

export function readPrompt() {
  const source = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");
  const match = source.match(/const AUTO_SUMMARY_PROMPT = `([\s\S]*?)`;\n\nconst DEFAULT_SETTINGS/);
  if (!match) throw new Error("无法从 extension/sidepanel.js 提取 AUTO_SUMMARY_PROMPT。");
  return match[1];
}

export const renderPromptDoc = () => `${HEADER}${readPrompt()}\n`;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  writeFileSync(resolve(root, "docs/prompt.md"), renderPromptDoc());
  console.log("docs/prompt.md 已更新");
}
