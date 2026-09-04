import assert from "node:assert/strict";
import test from "node:test";

import { installDom, startFakeServer } from "./harness/dom.mjs";

const READER = new URL("../sidepanel.js", import.meta.url).href;
const PDF_URL = "https://example.org/paper.pdf";

/** 每个用例都要一份干净的模块实例，用 query 后缀绕开 ESM 缓存。 */
let instance = 0;
async function bootReader({ backendUrl, search = `?pdf=${encodeURIComponent(PDF_URL)}&title=%E5%8D%A0%E4%BD%8D`, storage }) {
  const dom = installDom({
    search,
    storage: storage ?? { readerSettings: { backendUrl, accessToken: "" } }
  });
  await import(`${READER}?case=${++instance}`);
  return dom;
}

async function waitForIdle(dom, maxTicks = 200) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (tick > 4 && dom.el("send-button").hidden === false && dom.el("stop-button").hidden === true) return;
  }
  throw new Error("阅读器一直没有回到空闲状态");
}

const bodies = (dom) => dom.el("chat-list").querySelectorAll("message-body");
const sessionKey = (dom) => Object.keys(dom.store).find((key) => key.startsWith("paperSession:"));

test("打开论文后自动解析、流式生成导读，并展示解析实据", async () => {
  const fake = await startFakeServer();
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);

    // 标题来自服务端解析结果，而不是 URL 里的占位
    assert.equal(dom.el("paper-title").textContent, "A Parsed Paper Title");
    assert.match(dom.el("doc-facts").textContent, /已送入模型：10 页 · 7\.9 万 字符 · 2 张图表页/);
    assert.equal(dom.el("doc-facts").hidden, false);

    // 自动导读的 user 消息是隐藏的，界面上只应看到助手那条
    assert.equal(dom.el("chat-list").children.length, 1);
    assert.match(bodies(dom).at(-1).innerHTML, /<h2>一句话总结<\/h2>/);
    assert.ok(!bodies(dom).at(-1).innerHTML.includes("streaming-cursor"));

    // 默认让本地服务自己去取 PDF，浏览器不重复下载
    assert.deepEqual(fake.state.uploads, [{ url: PDF_URL }]);
    assert.equal(dom.store[sessionKey(dom)].schema, 2);
  } finally {
    fake.close();
  }
});

test("追问会带上历史，并复用已解析的论文", async () => {
  const fake = await startFakeServer();
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);

    dom.el("message-input").value = "第二个问题";
    await dom.el("send-button").dispatch("click", {});
    await waitForIdle(dom);

    assert.equal(fake.state.uploads.length, 1, "追问不应重新上传论文");
    const followUp = fake.state.chats.at(-1);
    assert.equal(followUp.message, "第二个问题");
    assert.equal(followUp.history.at(-1).role, "assistant", "历史里应带上上一轮回答");
    assert.equal(followUp.history[0].role, "user");
    assert.equal(dom.el("chat-list").children.length, 3);
  } finally {
    fake.close();
  }
});

test("论文缓存失效时自动重新解析并续答，用户看不到错误", async () => {
  const fake = await startFakeServer();
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);
    const staleFileId = dom.store[sessionKey(dom)].fileId;

    fake.state.documents.clear();          // 模拟服务重启／缓存被挤掉
    dom.el("message-input").value = "缓存没了之后再问";
    await dom.el("send-button").dispatch("click", {});
    await waitForIdle(dom);

    assert.equal(fake.state.uploads.length, 2, "应当自动重传一次");
    assert.notEqual(dom.store[sessionKey(dom)].fileId, staleFileId);
    assert.equal(dom.el("chat-list").querySelectorAll("message-error").length, 0, "不该让用户看到错误");
    assert.match(bodies(dom).at(-1).innerHTML, /<h2>/);
  } finally {
    fake.close();
  }
});

test("生成途中往上翻，不会被拽回底部；贴着底部时仍跟随", async () => {
  const fake = await startFakeServer({ chunks: Array.from({ length: 25 }, (_, i) => `第 ${i} 段。\n`) });
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);
    const chat = dom.el("chat-list");
    chat.scrollHeight = 5000;
    chat.clientHeight = 400;

    // 贴底 → 应当跟随
    chat.scrollTop = 4600;
    await chat.dispatch("scroll", {});
    dom.el("message-input").value = "贴底提问";
    let pending = dom.el("send-button").dispatch("click", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(chat.scrollTop > 4000, "贴底时应自动跟随生成");
    await pending;
    await waitForIdle(dom);

    // 生成途中上翻 → 必须停在原地
    dom.el("message-input").value = "翻上去读";
    pending = dom.el("send-button").dispatch("click", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chat.scrollTop = 0;
    await chat.dispatch("scroll", {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(chat.scrollTop, 0, "生成途中被拽回了底部");
    await pending;
    await waitForIdle(dom);
    assert.equal(chat.scrollTop, 0, "生成结束时又被拽回了底部");
  } finally {
    fake.close();
  }
});

test("生成中可以停止，且不弹错误气泡", async () => {
  const fake = await startFakeServer({ chunks: Array.from({ length: 60 }, () => "很长的内容。") });
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);

    dom.el("message-input").value = "讲一个很长的答案";
    const pending = dom.el("send-button").dispatch("click", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(dom.el("stop-button").hidden, false, "生成中应显示停止按钮");
    assert.notEqual(dom.el("message-input").disabled, true, "等待时输入框仍应可用");

    await dom.el("stop-button").dispatch("click", {});
    await pending;
    await waitForIdle(dom);

    assert.match(dom.el("document-status").innerHTML, /已停止生成/);
    assert.equal(dom.el("chat-list").querySelectorAll("message-error").length, 0, "主动停止不是错误");
  } finally {
    fake.close();
  }
});

test("对上旧版本地服务时，给出可操作提示而不是 JSON 报错", async () => {
  const fake = await startFakeServer({ protocol: null });   // 旧服务的 /health 不带 protocol
  try {
    const dom = await bootReader({ backendUrl: fake.url });
    await waitForIdle(dom);

    const shown = bodies(dom).map((body) => body.textContent).join("\n");
    assert.match(shown, /本地服务是旧版本/);
    assert.match(shown, /npm start/);
    assert.ok(!shown.includes("请求 JSON 格式无效"));
    assert.equal(fake.state.uploads.length, 0, "版本不对就不该再往下走");
  } finally {
    fake.close();
  }
});

test("没有绑定 PDF 时展示空状态和本地文件入口", async () => {
  const dom = await bootReader({ backendUrl: "http://127.0.0.1:1", search: "" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(dom.el("empty-state").hidden, false);
  assert.equal(dom.el("pdf-frame").hidden, true);
  assert.match(dom.el("empty-copy").textContent, /本地 PDF/);
});

test("重开已读过的论文时，标题不会退回 URL 猜出来的占位符", async () => {
  const fake = await startFakeServer();
  try {
    // 上一轮读完的会话：真标题存在 facts 里，消息已经有了所以不会重新上传
    const key = "paperSession:";
    const first = await bootReader({ backendUrl: fake.url });
    await waitForIdle(first);
    const saved = first.store[sessionKey(first)];
    assert.equal(saved.facts.title, "A Parsed Paper Title");

    const uploadsBefore = fake.state.uploads.length;
    const dom = await bootReader({
      backendUrl: fake.url,
      storage: {
        readerSettings: { backendUrl: fake.url, accessToken: "" },
        [sessionKey(first)]: saved
      }
    });
    // 恢复会话不会触发生成，所以等的是标题落定，不是空闲信号
    for (let tick = 0; tick < 80 && dom.el("paper-title").textContent !== "A Parsed Paper Title"; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(dom.el("paper-title").textContent, "A Parsed Paper Title");
    assert.equal(dom.el("pdf-title").textContent, "A Parsed Paper Title");
    // 没有重新上传，标题纯粹来自存下来的 facts
    assert.equal(fake.state.uploads.length, uploadsBefore);
    assert.ok(key);
  } finally {
    fake.close();
  }
});

test("上一轮生成中断留下的空回答会被丢掉，自动导读重新跑一遍", async () => {
  const fake = await startFakeServer();
  try {
    const probe = await bootReader({ backendUrl: fake.url });
    await waitForIdle(probe);
    const key = sessionKey(probe);

    const dom = await bootReader({
      backendUrl: fake.url,
      storage: {
        readerSettings: { backendUrl: fake.url, accessToken: "" },
        [key]: {
          schema: 2,
          url: PDF_URL,
          fileId: "",
          facts: null,
          messages: [
            { role: "user", text: "自动导读", hidden: true },
            { id: "x", role: "assistant", text: "", streaming: true }
          ],
          updatedAt: Date.now()
        }
      }
    });
    await waitForIdle(dom);

    // 卡住的空气泡没了，自动导读补上了一条真回答
    assert.equal(dom.el("chat-list").children.length, 1);
    assert.match(bodies(dom).at(-1).innerHTML, /<h2>一句话总结<\/h2>/);
    assert.ok(!bodies(dom).at(-1).innerHTML.includes("streaming-cursor"));
  } finally {
    fake.close();
  }
});
