const CHROME_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

chrome.action.onClicked.addListener((tab) => {
  void openReaderFromTab(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "OPEN_READER") return false;
  const title = cleanTitle(message.title || sender.tab?.title || "未命名论文");
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
  await openReader(pdfUrl, cleanTitle(tab?.title || filenameFromUrl(pdfUrl)));
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

function cleanTitle(title) {
  return String(title)
    .replace(/^\s*Title:\s*/i, "")
    .replace(/\s*[-|]\s*(Google Chrome|Microsoft Edge)$/i, "")
    .replace(/\.pdf$/i, "")
    .trim()
    .slice(0, 180) || "未命名论文";
}

function filenameFromUrl(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() || "未命名论文").replace(/\.pdf$/i, "");
  } catch {
    return "未命名论文";
  }
}
