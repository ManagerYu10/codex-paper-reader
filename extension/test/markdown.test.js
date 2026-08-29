import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../markdown.js";

test("renders standard headings, bold text, and bullet lists", () => {
  const html = renderMarkdown("## 核心工作\n- **方法：** 新模型\n- **结果：** 更准确");
  assert.match(html, /<h2>核心工作<\/h2>/);
  assert.match(html, /<ul><li><strong>方法：<\/strong> 新模型<\/li>/);
  assert.match(html, /<li><strong>结果：<\/strong> 更准确<\/li><\/ul>/);
});

test("keeps ordered lists continuous across blank lines and mixed markers", () => {
  const html = renderMarkdown([
    "1. 第一步",
    "",
    "1) 第二步",
    "",
    "1. 第三步"
  ].join("\n"));
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /<ol><li>第一步<\/li><li>第二步<\/li><li>第三步<\/li><\/ol>/);
});

test("renders GitHub-style Markdown tables with alignment", () => {
  const html = renderMarkdown([
    "| 评价目标 | EditProbe SRCC |",
    "|:---|---:|",
    "| 感知质量 | **0.6959** |",
    "| 编辑对齐度 | 0.7995 |"
  ].join("\n"));
  assert.match(html, /<div class="table-scroll"/);
  assert.match(html, /<th class="align-left">评价目标<\/th>/);
  assert.match(html, /<th class="align-right">EditProbe SRCC<\/th>/);
  assert.match(html, /<td class="align-right"><strong>0.6959<\/strong><\/td>/);
  assert.match(html, /<tbody><tr>/);
});

test("tolerates a single blank line between generated table rows", () => {
  const html = renderMarkdown([
    "| 评价目标 | EditProbe SRCC |",
    "",
    "|---|---:|",
    "",
    "| 感知质量 | 0.6959 |",
    "",
    "| 编辑对齐度 | 0.7995 |"
  ].join("\n"));
  assert.match(html, /<table>/);
  assert.match(html, /<td class="align-left">感知质量<\/td>/);
  assert.match(html, /<td class="align-right">0.7995<\/td>/);
  assert.doesNotMatch(html, /<p>\|---\|---:\|<\/p>/);
});

test("escapes untrusted HTML inside Markdown and tables", () => {
  const html = renderMarkdown("| 名称 | 值 |\n|---|---|\n| <script> | **安全** |");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
