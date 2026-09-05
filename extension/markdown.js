const isQuoteLine = (line) => /^\s*>/.test(line);

export function renderMarkdown(markdown) {
  const codeBlocks = [];
  const text = String(markdown || "").replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_match, code) => {
    const index = codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`) - 1;
    return `\n@@CODEBLOCK_${index}@@\n`;
  });

  const lines = text.split(/\r?\n/);
  const output = [];
  let listType = "";
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  // 连续的引用行要合成一个 blockquote，否则一段大白话会被切成几个断开的引用框。
  let inQuote = false;
  const closeQuote = () => {
    if (inQuote) output.push("</blockquote>");
    inQuote = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();
    // 一旦离开引用块就把它收掉；判断放在最前，后面每条分支都不用各自操心。
    if (inQuote && !isQuoteLine(line)) closeQuote();
    const codeMatch = line.match(/^@@CODEBLOCK_(\d+)@@$/);
    if (codeMatch) {
      closeList();
      output.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }
    if (!line.trim()) {
      if (!listContinuesAfterBlank(lines, index, listType)) closeList();
      continue;
    }

    const separatorIndex = findTableSeparator(lines, index);
    if (separatorIndex !== -1) {
      closeList();
      const headers = parseTableRow(line);
      const alignments = parseTableRow(lines[separatorIndex]).map(tableAlignment);
      const rows = [];
      let cursor = separatorIndex + 1;
      while (cursor < lines.length) {
        const rowIndex = nextTableLine(lines, cursor);
        if (rowIndex === -1 || !isTableRow(lines[rowIndex])) break;
        const cells = parseTableRow(lines[rowIndex]);
        if (cells.length !== headers.length) break;
        rows.push(cells);
        cursor = rowIndex + 1;
      }
      index = cursor - 1;
      output.push(renderTable(headers, alignments, rows));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }

    if (isQuoteLine(line)) {
      if (!inQuote) {
        closeList();
        output.push("<blockquote>");
        inQuote = true;
      } else {
        output.push("<br>");
      }
      // 模型偶尔会写成 ">大白话" 少一个空格，照样当引用处理
      output.push(inlineMarkdown(line.replace(/^\s*>\s?/, "")));
      continue;
    }

    closeList();
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeQuote();
  closeList();
  return output.join("");
}

function listContinuesAfterBlank(lines, index, listType) {
  if (!listType) return false;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const nextLine = String(lines[cursor] || "").trim();
    if (!nextLine) continue;
    if (listType === "ol") return /^\d+[.)]\s+/.test(nextLine);
    if (listType === "ul") return /^[-*]\s+/.test(nextLine);
    return false;
  }
  return false;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function findTableSeparator(lines, index) {
  if (!isTableRow(lines[index])) return -1;
  const separatorIndex = nextTableLine(lines, index + 1);
  if (separatorIndex === -1) return -1;
  const headers = parseTableRow(lines[index]);
  const separators = parseTableRow(lines[separatorIndex]);
  const matches = (
    headers.length >= 2 &&
    headers.length === separators.length &&
    separators.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
  return matches ? separatorIndex : -1;
}

function nextTableLine(lines, index) {
  if (index >= lines.length) return -1;
  if (String(lines[index] || "").trim()) return index;
  const nextIndex = index + 1;
  return nextIndex < lines.length && String(lines[nextIndex] || "").trim() ? nextIndex : -1;
}

function isTableRow(line) {
  const trimmed = String(line || "").trim();
  return trimmed.includes("|") && trimmed !== "|";
}

function parseTableRow(line) {
  let normalized = String(line || "").trim();
  if (normalized.startsWith("|")) normalized = normalized.slice(1);
  if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);
  return normalized.split("|").map((cell) => cell.trim());
}

function tableAlignment(separator) {
  const value = separator.replace(/\s/g, "");
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function renderTable(headers, alignments, rows) {
  const headerHtml = headers
    .map((header, index) => `<th class="align-${alignments[index]}">${inlineMarkdown(header)}</th>`)
    .join("");
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell, index) => `<td class="align-${alignments[index]}">${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-scroll" role="region" aria-label="论文数据表"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}
