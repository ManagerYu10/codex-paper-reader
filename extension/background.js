const CHROME_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

chrome.action.onClicked.addListener((tab) => {
  void openReaderFromTab(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "OPEN_READER") return false;
  const title = cleanTitle(message.title || sender.tab?.title || "", message.pdfUrl);
  openReader(message.pdfUrl, title)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function openReaderFromTab(tab) {
  const pdfUrl = resolvePdfUrl(tab?.url || "");
  if (!pdfUrl) {
    await flashActionError(tab?.id);
    return;
  }
  await openReader(pdfUrl, cleanTitle(tab?.title || "", pdfUrl));
}

async function openReader(rawPdfUrl, title) {
  const pdfUrl = resolvePdfUrl(rawPdfUrl);
  if (!pdfUrl) throw new Error("当前地址不是可读取的 PDF。");

  const readerUrl = new URL(chrome.runtime.getURL("sidepanel.html"));
  readerUrl.searchParams.set("pdf", pdfUrl);
  readerUrl.searchParams.set("title", title || filenameFromUrl(pdfUrl));
  await chrome.tabs.create({ url: readerUrl.href, active: true });
}

function resolvePdfUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "chrome-extension:" && parsed.hostname === CHROME_PDF_VIEWER_ID) {
      for (const key of ["file", "url", "src"]) {
        const candidate = parsed.searchParams.get(key);
        if (candidate) return resolvePdfUrl(decodeURIComponent(candidate));
      }
      return "";
    }

    if (parsed.hostname === "arxiv.org" || parsed.hostname === "export.arxiv.org") {
      const abstractMatch = parsed.pathname.match(/^\/abs\/([^/]+)\/?$/i);
      if (abstractMatch) return `${parsed.origin}/pdf/${abstractMatch[1]}.pdf`;
      const htmlMatch = parsed.pathname.match(/^\/html\/([^/]+)\/?$/i);
      if (htmlMatch) return `${parsed.origin}/pdf/${htmlMatch[1]}.pdf`;
    }

    if (!["http:", "https:", "file:"].includes(parsed.protocol)) return "";
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (parsed.protocol === "file:" || path.endsWith(".pdf") || path.includes("/pdf/")) return parsed.href;
    return "";
  } catch {
    return "";
  }
}

async function flashActionError(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a13f3f" });
  await chrome.action.setBadgeText({ tabId, text: "PDF?" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 2200);
}

const PLACEHOLDER_TITLE = "未命名论文";

function cleanTitle(title, fallbackUrl) {
  const cleaned = String(title || "")
    .replace(/^\s*Title:\s*/i, "")
    .replace(/\s*[-|]\s*(Google Chrome|Microsoft Edge)$/i, "")
    .replace(/\.pdf$/i, "")
    .trim()
    .slice(0, 180);
  // 没刷新的旧 content script 仍会发来字面量占位符，它是 truthy，
  // 会顶掉后面更好的兜底，所以在这里就当成没给。
  // 标题只是初始占位；论文真正的标题由本地 PyMuPDF 抽出后再覆盖。
  if (!cleaned || cleaned === PLACEHOLDER_TITLE) return filenameFromUrl(fallbackUrl);
  return cleaned;
}

function filenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const arxiv = parsed.pathname.match(/\/(?:pdf|abs|html)\/([^/]+?)(?:\.pdf)?\/?$/i);
    if (arxiv && /(^|\.)arxiv\.org$/i.test(parsed.hostname)) return `arXiv ${arxiv[1]}`;
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "")
      .replace(/\.pdf$/i, "");
    // openreview 这类把论文 id 放在查询串里，路径末段只是个 "pdf"，没有信息量
    if (!name || /^(pdf|download|view|file|paper)$/i.test(name)) {
      for (const key of ["id", "doi", "arxivId", "paperId"]) {
        const value = parsed.searchParams.get(key);
        if (value) return `${parsed.hostname} ${value}`.slice(0, 180);
      }
      return parsed.hostname || PLACEHOLDER_TITLE;
    }
    return name;
  } catch {
    return PLACEHOLDER_TITLE;
  }
}
