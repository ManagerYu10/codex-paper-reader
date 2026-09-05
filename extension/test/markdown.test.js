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

test("连续的引用行合成一个引用块，不会被切成好几个", () => {
  const html = renderMarkdown("> **大白话（直觉解释）：** 第一句。\n> 第二句接着说。");
  assert.equal((html.match(/<blockquote>/g) || []).length, 1, "只该有一个引用块");
  assert.match(html, /<strong>大白话（直觉解释）：<\/strong>/);
  assert.match(html, /第一句。<br>第二句接着说。/);
});

test("引用符号后面漏了空格也照样当引用", () => {
  assert.match(renderMarkdown(">**大白话：** 漏了空格。"), /^<blockquote><strong>大白话：<\/strong>/);
  // 不该把 > 当成正文漏出来
  assert.ok(!renderMarkdown(">**大白话：** 漏了空格。").includes("&gt;"));
});

test("引用块会在遇到普通内容时正确收尾", () => {
  const html = renderMarkdown("> 引用。\n\n普通段落。\n\n- 列表项");
  assert.match(html, /<blockquote>引用。<\/blockquote><p>普通段落。<\/p><ul><li>列表项<\/li><\/ul>/);
  // 引用紧跟标题时也不能把标题吞进去
  assert.match(renderMarkdown("> 引用。\n## 标题"), /<\/blockquote><h2>标题<\/h2>/);
});
