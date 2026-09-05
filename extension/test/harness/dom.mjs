// 让 extension/sidepanel.js 的真实代码能在 Node 里跑起来的最小桩。
// 只实现该文件真正用到的 DOM / chrome API，不追求通用。

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); this.sync(); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); this.sync(); }
  contains(name) { return this.set.has(name); }
  sync() { this.el._className = [...this.set].join(" "); }
}

export class FakeElement {
  constructor(tag = "div", className = "") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._className = className;
    className.split(/\s+/).filter(Boolean).forEach((n) => this.classList.set.add(n));
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 400;
    this.attributes = {};
  }
  get className() { return this._className; }
  set className(v) {
    this._className = v;
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map((fn) => fn(event)));
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node && node.isFragment) this.children.push(...node.children);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  removeAttribute(name) { delete this.attributes[name]; if (name in this) this[name] = undefined; }
  // 位置必须照做：afterbegin 插到最前，beforeend 追加。
  // 以前这里无视 position 一律追加，会让"目录插在正文之前"这类断言假通过。
  insertAdjacentHTML(position, html) {
    if (position === "afterbegin") this.innerHTML = html + this.innerHTML;
    else if (position === "beforeend") this.innerHTML += html;
    else throw new Error(`未桩接的 insertAdjacentHTML 位置：${position}`);
  }
  scrollTo(opts) { this.scrollTop = opts?.top ?? 0; }
  scrollIntoView() {}
  click() { return this.dispatch("click", {}); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  get lastElementChild() { return this.children.at(-1) || null; }
  _all() { return this.children.flatMap((c) => [c, ...(c._all ? c._all() : [])]); }
  querySelectorAll(selector) {
    const cls = selector.replace(/^\./, "");
    return this._all().filter((c) => c.classList?.contains(cls));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeFragment {
  constructor(children) { this.isFragment = true; this.children = children; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, "");
    const all = this.children.flatMap((c) => [c, ...c._all()]);
    return all.filter((c) => c.classList?.contains(cls));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  cloneNode() { return makeMessageFragment(); }
}

function makeMessageFragment() {
  const article = new FakeElement("article", "message");
  const meta = new FakeElement("div", "message-meta");
  meta.append(new FakeElement("span", "message-avatar"), new FakeElement("strong", "message-author"));
  article.append(meta, new FakeElement("div", "message-body"));
  return new FakeFragment([article]);
}

// sidepanel.js 里 querySelector("#id") 引用到的全部元素
const IDS = [
  "pdf-title", "pdf-frame", "pdf-empty", "open-original-button", "paper-title",
  "document-status", "doc-facts", "empty-state", "empty-title", "empty-copy",
  "pick-file-button", "file-picker", "welcome-state", "chat-list", "message-input",
  "send-button", "stop-button", "new-session-button", "upload-progress",
  "upload-progress-text", "model-badge", "active-model", "settings-button",
  "settings-dialog", "settings-form", "close-settings-button", "backend-url",
  "access-token", "connection-result", "test-connection-button", "message-template"
];

export function installDom({ search = "", storage = {} } = {}) {
  const byId = new Map(IDS.map((id) => [id, new FakeElement("div", id)]));
  byId.get("message-template").content = { cloneNode: () => makeMessageFragment() };
  byId.get("chat-list").scrollHeight = 1000;

  globalThis.document = {
    title: "",
    querySelector(sel) {
      const id = sel.replace(/^#/, "");
      if (!byId.has(id)) throw new Error(`未桩接的元素 #${id}`);
      return byId.get(id);
    }
  };
  globalThis.location = { search };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.confirm = () => true;
  globalThis.URL.createObjectURL = () => "blob:fake";

  const store = { ...storage };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
          return { ...store };
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; }
      }
    }
  };
  return { byId, store, el: (id) => byId.get(id) };
}

/** 假的本地阅读服务：不需要 API Key 和网络，就能驱动扩展跑完整条链路。 */
export async function startFakeServer({ protocol = 2, chunks = ["## 一句话总结\n", "这是一段导读。\n"] } = {}) {
  const { createServer } = await import("node:http");
  const state = { documents: new Set(), uploads: [], chats: [], failNextChatWith404: false };
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    const url = request.url;
    const body = await new Promise((resolve) => {
      const chunks = [];
      request.on("data", (c) => chunks.push(c));
      request.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };

    if (url === "/health") {
      return json(200, { ok: true, ...(protocol ? { protocol } : {}), apiKeyConfigured: true, model: "deepseek-v4-flash-vision-exp" });
    }
    if (url === "/api/documents") {
      const isJson = String(request.headers["content-type"] || "").includes("json");
      state.uploads.push(isJson ? JSON.parse(body.toString()) : { bytes: body.length });
      const fileId = `doc_${"a".repeat(31)}${state.uploads.length}`;
      state.documents.add(fileId);
      return json(201, { fileId, title: "A Parsed Paper Title", pages: 10, chars: 79054, figurePages: [1, 3], imageCount: 2, scanned: false });
    }
    if (url === "/api/documents/delete") {
      state.documents.delete(JSON.parse(body.toString()).fileId);
      return json(200, { deleted: true });
    }
    if (url === "/api/chat/stream") {
      const payload = JSON.parse(body.toString());
      state.chats.push(payload);
      if (!state.documents.has(payload.fileId)) return json(404, { error: "本地论文缓存已失效，正在重新读取原文。" });
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const delta of chunks) {
        response.write(`${JSON.stringify({ type: "delta", delta })}\n`);
        await new Promise((r) => setTimeout(r, 40));
      }
      response.write(`${JSON.stringify({ type: "done", usage: null, truncated: false })}\n`);
      return response.end();
    }
    json(404, { error: "接口不存在。" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
