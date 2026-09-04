const BUTTON_ID = "codex-gpt-paper-reader-entry";
const POSITION_KEY = "readerButtonPosition";
// 右上角是各家扩展按钮带，右侧垂直居中是各家悬浮球的位置——两处都不能盲选。
// 所以不写死位置，而是沿右侧从下往上探，挑一个没被别人占住的空位。
const CANDIDATE_SLOTS = [0.72, 0.84, 0.62, 0.5, 0.38, 0.26];
const DEFAULT_POSITION = { top: 0.72, right: 18 };
const DRAG_THRESHOLD = 4;
// 比别家低一档：万一还是重叠了，让对方的按钮拿到点击，而不是被我吃掉。
const Z_INDEX = 2147482000;

if (isArxivAbstractPage()) {
  addArxivEntry();
} else if (isLikelyPdfPage()) {
  void addPdfEntry();
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

async function addPdfEntry() {
  if (document.getElementById(BUTTON_ID)) return;
  const host = createButtonHost("floating");
  (document.body || document.documentElement).append(host);
  await restorePosition(host);
  enableDragging(host);
  bindOpen(host, location.href, paperTitle());
}

function createButtonHost(mode) {
  const host = document.createElement("span");
  host.id = BUTTON_ID;
  if (mode === "inline") host.style.marginLeft = "10px";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { ${mode === "floating"
        ? `position:fixed;z-index:${Z_INDEX};touch-action:none;`
        : "display:inline-block;vertical-align:middle;"} }
      button {
        display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:0;border-radius:999px;
        background:#1a7f5a;color:#fff;box-shadow:0 3px 12px rgba(26,127,90,.3);
        font:700 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
        cursor:${mode === "floating" ? "grab" : "pointer"};user-select:none;
      }
      button:hover { background:#14664799;background:#146647; }
      button:disabled { opacity:.7;cursor:wait; }
      :host(.dragging) button { cursor:grabbing;box-shadow:0 6px 18px rgba(26,127,90,.45); }
      i { font-style:normal;font-size:12px; }
      b { font-weight:400;opacity:.55;font-size:11px;letter-spacing:.5px; }
    </style>
    <button type="button" title="${mode === "floating"
      ? "点击打开论文导读；按住可拖动，避开其他扩展的按钮"
      : "在独立网页中打开论文导读"}">
      <i>✦</i><span>论文导读</span>${mode === "floating" ? "<b>⠿</b>" : ""}
    </button>
  `;
  return host;
}

async function restorePosition(host) {
  let stored = null;
  try {
    stored = (await chrome.storage.local.get(POSITION_KEY))[POSITION_KEY] || null;
  } catch {
    // storage 不可用就走自动选位，不影响按钮本身
  }
  if (stored) {
    applyPosition(host, stored);       // 用户自己拖过，尊重他的选择
    return;
  }
  applyPosition(host, { top: findFreeSlot(host), right: DEFAULT_POSITION.right });
  // 别家的悬浮球常常晚于 document_idle 才注入，稍后再让一次位
  setTimeout(() => {
    if (host.dataset.userPlaced === "true") return;
    applyPosition(host, { top: findFreeSlot(host), right: DEFAULT_POSITION.right });
  }, 2000);
}

/** 沿右侧挑一个没有其他浮动控件占住的纵向位置。 */
function findFreeSlot(host) {
  const height = host.offsetHeight || 32;
  for (const ratio of CANDIDATE_SLOTS) {
    const centerY = ratio * window.innerHeight;
    if (isSlotFree(host, window.innerWidth - DEFAULT_POSITION.right - 55, centerY)) return ratio;
  }
  return CANDIDATE_SLOTS[0];
}

function isSlotFree(host, x, y) {
  const previous = host.style.pointerEvents;
  host.style.pointerEvents = "none";          // 先让开，免得探到自己
  let occupied = false;
  try {
    let node = document.elementFromPoint(x, y);
    while (node && node !== document.body && node !== document.documentElement) {
      if (node === host) return false;
      // 别人的浮动控件：固定/绝对定位且压在内容之上
      const style = getComputedStyle(node);
      if ((style.position === "fixed" || style.position === "absolute") && Number(style.zIndex) > 1000) {
        occupied = true;
        break;
      }
      node = node.parentElement;
    }
  } catch {
    occupied = false;
  } finally {
    host.style.pointerEvents = previous;
  }
  return !occupied;
}

function applyPosition(host, position) {
  const height = host.offsetHeight || 32;
  const top = typeof position.top === "number" && position.top <= 1
    ? position.top * window.innerHeight - height / 2   // 比例：跟随窗口高度
    : position.top;
  host.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - height - 8))}px`;
  host.style.right = `${clamp(position.right ?? DEFAULT_POSITION.right, 8, window.innerWidth - 60)}px`;
  host.style.left = "auto";
}

function enableDragging(host) {
  const button = host.shadowRoot.querySelector("button");
  let origin = null;

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    origin = { x: event.clientX, y: event.clientY, top: rect.top, right: window.innerWidth - rect.right, moved: false };
    button.setPointerCapture(event.pointerId);
  });

  button.addEventListener("pointermove", (event) => {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!origin.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    origin.moved = true;
    host.classList.add("dragging");
    applyPosition(host, { top: origin.top + dy, right: origin.right - dx });
  });

  button.addEventListener("pointerup", (event) => {
    if (!origin) return;
    const dragged = origin.moved;
    origin = null;
    host.classList.remove("dragging");
    button.releasePointerCapture?.(event.pointerId);
    if (!dragged) return;
    // click 在 pointerup 之后才触发，得留个标记让它跳过一次，否则拖完就误打开阅读页
    host.dataset.suppressClick = "true";
    host.dataset.userPlaced = "true";
    const rect = host.getBoundingClientRect();
    chrome.storage.local.set({
      [POSITION_KEY]: { top: rect.top, right: Math.round(window.innerWidth - rect.right) }
    }).catch(() => {});
  });

  host.dataset.draggable = "true";
  window.addEventListener("resize", () => {
    const rect = host.getBoundingClientRect();
    applyPosition(host, { top: rect.top, right: Math.round(window.innerWidth - rect.right) });
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function bindOpen(host, pdfUrl, title) {
  const button = host.shadowRoot.querySelector("button");
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (host.dataset.suppressClick === "true") {
      delete host.dataset.suppressClick;
      return;
    }
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "OPEN_READER", pdfUrl, title });
      if (!result?.ok) throw new Error(result?.error || "打开失败");
    } catch (error) {
      button.title = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function paperTitle() {
  const arxivTitle = document.querySelector("h1.title")?.textContent;
  // 拿不到就返回空串。绝不能在这里塞占位符——它是 truthy，会把 background
  // 里那串更靠谱的兜底（tab 标题、URL、arXiv 编号）全部短路掉。
  return String(arxivTitle || document.title || "")
    .replace(/^\s*Title:\s*/i, "")
    .replace(/\.pdf\s*$/i, "")
    .trim();
}
