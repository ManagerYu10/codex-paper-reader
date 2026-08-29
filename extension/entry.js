const BUTTON_ID = "codex-gpt-paper-reader-entry";

if (isArxivAbstractPage()) {
  addArxivEntry();
} else if (isLikelyPdfPage()) {
  addPdfEntry();
}

function isArxivAbstractPage() {
  return ["arxiv.org", "export.arxiv.org"].includes(location.hostname) && /^\/abs\//i.test(location.pathname);
}

function isLikelyPdfPage() {
  const path = decodeURIComponent(location.pathname).toLowerCase();
  return document.contentType === "application/pdf" || path.endsWith(".pdf") || path.includes("/pdf/");
}

function addArxivEntry() {
  const pdfLink = [...document.querySelectorAll('a[href*="/pdf/"]')]
    .find((anchor) => /view pdf|download pdf|pdf/i.test(anchor.textContent || anchor.href));
  if (!pdfLink || document.getElementById(BUTTON_ID)) return;

  const host = createButtonHost("inline");
  pdfLink.parentElement?.append(host);
  bindOpen(host, new URL(pdfLink.href, location.href).href, paperTitle());
}

function addPdfEntry() {
  if (document.getElementById(BUTTON_ID)) return;
  const host = createButtonHost("floating");
  (document.body || document.documentElement).append(host);
  bindOpen(host, location.href, paperTitle());
}

function createButtonHost(mode) {
  const host = document.createElement("span");
  host.id = BUTTON_ID;
  if (mode === "inline") host.style.marginLeft = "10px";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { ${mode === "floating" ? "position:fixed;top:12px;right:118px;z-index:2147483647;" : "display:inline-block;vertical-align:middle;"} }
      button {
        display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:0;border-radius:999px;
        background:#1769e0;color:#fff;box-shadow:0 3px 12px rgba(23,105,224,.28);
        font:700 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
        cursor:pointer;
      }
      button:hover { background:#0f57c3;transform:translateY(-1px); }
      button:disabled { opacity:.7;cursor:wait;transform:none; }
      i { font-style:normal;font-size:12px; }
    </style>
    <button type="button" title="在独立网页中打开 GPT 论文导读"><i>✦</i><span>GPT 导读</span></button>
  `;
  return host;
}

function bindOpen(host, pdfUrl, title) {
  const button = host.shadowRoot.querySelector("button");
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "OPEN_READER", pdfUrl, title });
      if (!result?.ok) throw new Error(result?.error || "打开失败");
    } catch (error) {
      button.disabled = false;
      button.title = error.message;
    }
  });
}

function paperTitle() {
  const arxivTitle = document.querySelector("h1.title")?.textContent;
  return String(arxivTitle || document.title || "未命名论文")
    .replace(/^\s*Title:\s*/i, "")
    .replace(/\.pdf\s*$/i, "")
    .trim();
}
