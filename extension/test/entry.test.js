import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/** entry.js 跑在任意网页里，这里只桩接它真正用到的那点 DOM 和 pointer 事件。 */
class StubElement {
  constructor(tag) {
    this.tagName = tag;
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.disabled = false;
    this.offsetHeight = 32;
  }
  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name)
    };
  }
  attachShadow() {
    this.shadowRoot = {
      set innerHTML(html) { this._html = html; },
      get innerHTML() { return this._html; },
      button: new StubElement("button"),
      querySelector() { return this.button; }
    };
    return this.shadowRoot;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  async fire(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) await handler(event);
  }
  append() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    const top = parseFloat(this.style.top) || 0;
    const right = 1600 - (parseFloat(this.style.right) || 0);
    return { top, right, bottom: top + 32, left: right - 110, width: 110, height: 32 };
  }
}

let mountCount = 0;

async function mountOnPdfPage({ occupied = [] } = {}) {
  const stored = {};
  const created = [];
  let opened = 0;

  // occupied: [{ fromRatio, toRatio }] 表示右侧这一段纵向区间被别家浮动控件占住
  const foreignWidget = { tagName: "DIV", parentElement: null, __foreign: true };
  globalThis.getComputedStyle = (node) =>
    (node && node.__foreign ? { position: "fixed", zIndex: "2147483647" } : { position: "static", zIndex: "auto" });

  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (value) => { Object.assign(stored, value); }
      }
    },
    runtime: { sendMessage: async () => { opened += 1; return { ok: true }; } }
  };
  globalThis.window = { innerWidth: 1600, innerHeight: 900, addEventListener() {} };
  globalThis.document = {
    contentType: "application/pdf",
    title: "some-paper.pdf",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    elementFromPoint: (_x, y) => {
      const ratio = y / 900;
      const hit = occupied.some((range) => ratio >= range.fromRatio && ratio <= range.toRatio);
      return hit ? foreignWidget : globalThis.document.body;
    },
    createElement: (tag) => { const element = new StubElement(tag); created.push(element); return element; },
    body: { append() {}, parentElement: null },
    documentElement: { append() {} }
  };
  globalThis.location = {
    hostname: "arxiv.org",
    pathname: "/pdf/2602.13344",
    href: "https://arxiv.org/pdf/2602.13344"
  };

  // data: 模块按内容缓存，加个唯一后缀才能让 entry.js 的顶层代码每次都重跑
  const source = `${readFileSync(new URL("../entry.js", import.meta.url), "utf8")}\n//${mountCount += 1}`;
  await import(`data:text/javascript,${encodeURIComponent(source)}`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const host = created[0];
  return { host, button: host.shadowRoot.button, stored, opened: () => opened };
}

test("空页面上默认贴右边缘，且避开右上角的扩展按钮带", async () => {
  const { host } = await mountOnPdfPage();
  const ratio = (parseFloat(host.style.top) + 16) / 900;
  assert.ok(parseFloat(host.style.right) < 30, "默认应贴住右边缘");
  assert.ok(ratio > 0.2, `落在了右上角按钮带里：ratio=${ratio.toFixed(2)}`);
  // 垂直居中留给别家的悬浮球，我们默认往下偏
  assert.ok(Math.abs(ratio - 0.5) > 0.05, `不该默认占住悬浮球位：ratio=${ratio.toFixed(2)}`);
});

test("拖动之后不会误触发打开，位置被记住", async () => {
  const { button, stored, opened } = await mountOnPdfPage();
  const before = opened();

  await button.fire("pointerdown", { button: 0, clientX: 1500, clientY: 300, pointerId: 1 });
  await button.fire("pointermove", { clientX: 1400, clientY: 700, pointerId: 1 });
  await button.fire("pointerup", { clientX: 1400, clientY: 700, pointerId: 1 });
  // click 总是在 pointerup 之后才到，必须被吃掉
  await button.fire("click", { preventDefault() {}, stopPropagation() {} });

  assert.equal(opened(), before, "拖动结束后又打开了一次阅读页");
  assert.ok(stored.readerButtonPosition, "拖动后没有记住位置");
});

test("原地点击仍然正常打开，轻微手抖不算拖动", async () => {
  const { button, opened } = await mountOnPdfPage();

  await button.fire("pointerdown", { button: 0, clientX: 900, clientY: 400, pointerId: 2 });
  await button.fire("pointerup", { clientX: 900, clientY: 400, pointerId: 2 });
  await button.fire("click", { preventDefault() {}, stopPropagation() {} });
  assert.equal(opened(), 1, "原地点击没有打开阅读页");

  await button.fire("pointerdown", { button: 0, clientX: 900, clientY: 400, pointerId: 3 });
  await button.fire("pointermove", { clientX: 901, clientY: 401, pointerId: 3 });
  await button.fire("pointerup", { clientX: 901, clientY: 401, pointerId: 3 });
  await button.fire("click", { preventDefault() {}, stopPropagation() {} });
  assert.equal(opened(), 2, "手抖 1px 就被误判成拖动了");
});

test("默认位置会避开别家已经占住的悬浮球", async () => {
  // 豆包悬浮球通常在右侧垂直居中，占住 0.44~0.56 这一段
  const { host } = await mountOnPdfPage({ occupied: [{ fromRatio: 0.44, toRatio: 0.56 }] });
  const top = parseFloat(host.style.top);
  const ratio = (top + 16) / 900;
  assert.ok(ratio < 0.44 || ratio > 0.56, `按钮落在了被占用的区间：ratio=${ratio.toFixed(2)}`);
});

test("右上角和右侧中部都被占时，仍能找到空位落脚", async () => {
  const { host } = await mountOnPdfPage({
    occupied: [{ fromRatio: 0, toRatio: 0.2 }, { fromRatio: 0.44, toRatio: 0.56 }]
  });
  const ratio = (parseFloat(host.style.top) + 16) / 900;
  assert.ok(ratio > 0.2 && (ratio < 0.44 || ratio > 0.56), `没避开：ratio=${ratio.toFixed(2)}`);
});

test("层级比别家低一档，万一重叠也不会吃掉对方的点击", async () => {
  const { host } = await mountOnPdfPage();
  const css = host.shadowRoot.innerHTML;
  const z = Number(css.match(/z-index:(\d+)/)[1]);
  assert.ok(z < 2147483647, `z-index 太高会压过所有人：${z}`);
  assert.ok(z > 1000000, "也不能低到被页面内容盖住");
});

test("用户拖过之后，自动避让不再覆盖他的选择", async () => {
  const { host, button, stored } = await mountOnPdfPage();
  await button.fire("pointerdown", { button: 0, clientX: 1500, clientY: 300, pointerId: 9 });
  await button.fire("pointermove", { clientX: 1480, clientY: 120, pointerId: 9 });
  await button.fire("pointerup", { clientX: 1480, clientY: 120, pointerId: 9 });
  assert.equal(host.dataset.userPlaced, "true", "没记住这是用户手动放的");
  assert.ok(stored.readerButtonPosition, "没落盘");
});
