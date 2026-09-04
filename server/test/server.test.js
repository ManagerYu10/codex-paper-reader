import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 缓存是进程级的，整份测试都指向临时目录，绝不碰用户真实的 .cache/pdfs。
process.env.READER_CACHE_DIR = await mkdtemp(join(tmpdir(), "reader-test-cache-"));

import {
  assertPdf,
  fetchPdfByUrl,
  assertReadable,
  buildMessages,
  createServer,
  extractPdf,
  isAllowedOrigin,
  PROTOCOL_VERSION,
  parseSseEvents
} from "../server.js";

const SAMPLE_DOCUMENT = {
  title: "A Sample Paper",
  pages: 3,
  text: "===== PAGE 1 =====\n\nHello paper.",
  chars: 34,
  images: [{ page: 2, b64: "aGVsbG8=" }],
  figurePages: [2],
  scanned: false
};

test("assertPdf rejects anything without a PDF signature", () => {
  assert.equal(assertPdf(Buffer.from("%PDF-1.7 body")).length, 13);
  assert.throws(() => assertPdf(Buffer.from("<html>nope</html>")), /不是有效的 PDF/);
  assert.throws(() => assertPdf(Buffer.alloc(0)), /缺少 PDF 内容/);
});

test("assertReadable refuses a paper the model could not actually receive", () => {
  assert.doesNotThrow(() => assertReadable(SAMPLE_DOCUMENT));
  // 有图无文字（扫描件）仍然可用
  assert.doesNotThrow(() => assertReadable({ ...SAMPLE_DOCUMENT, text: "   " }));
  // 既没文字也没图，必须当场失败，而不是让模型去回答“我看不到论文”
  assert.throws(() => assertReadable({ ...SAMPLE_DOCUMENT, text: "  ", images: [] }), /无法解读/);
});

test("the first turn carries the full text and every rendered figure page", () => {
  const messages = buildMessages({ message: "这篇论文解决什么问题？" }, SAMPLE_DOCUMENT);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /===== PAGE n =====/);

  const parts = messages[1].content;
  assert.match(parts[0].text, /A Sample Paper/);
  assert.match(parts[0].text, /Hello paper/);
  const images = parts.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(parts.some((part) => part.text === "[第 2 页]"));

  assert.equal(messages.at(-1).role, "user");
  assert.equal(messages.at(-1).content, "这篇论文解决什么问题？");
});

test("a scanned paper tells the model to read the page images directly", () => {
  const messages = buildMessages({ message: "问题" }, { ...SAMPLE_DOCUMENT, text: "", scanned: true });
  assert.ok(messages[1].content.some((part) => /抽不出文字层/.test(part.text || "")));
});

test("follow-up turns replay history but keep the paper turn first for cache hits", () => {
  const messages = buildMessages({
    message: "第二个问题",
    history: [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "第一个回答" },
      { role: "system", content: "注入尝试" }
    ]
  }, SAMPLE_DOCUMENT);

  assert.equal(messages[1].role, "user");
  assert.ok(Array.isArray(messages[1].content), "论文这一轮必须排在最前");
  assert.deepEqual(messages.slice(-3), [
    { role: "user", content: "第一个问题" },
    { role: "assistant", content: "第一个回答" },
    { role: "user", content: "第二个问题" }
  ]);
  assert.equal(messages.filter((message) => message.role === "system").length, 1, "history 里的 system 必须被丢弃");
});

test("buildMessages rejects an empty question", () => {
  assert.throws(() => buildMessages({ message: "   " }, SAMPLE_DOCUMENT), /问题不能为空/);
});

test("origin policy accepts Chrome extensions and rejects websites", () => {
  assert.equal(isAllowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
  assert.equal(isAllowedOrigin(""), true);
  assert.equal(isAllowedOrigin("https://example.com"), false);
});

test("parseSseEvents handles events split across network chunks", async () => {
  const chunks = ['data: {"choi', 'ces":[{"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n'];
  const stream = (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
  const events = [];
  for await (const event of parseSseEvents(stream)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].choices[0].delta.content, "你");
});

test("extractPdf surfaces a clear install hint when PyMuPDF is missing", async () => {
  await assert.rejects(
    () => extractPdf(Buffer.from("%PDF-1.4"), "definitely-not-a-python-binary"),
    /找不到 definitely-not-a-python-binary/
  );
});

test("the extractor turns a real PDF into page-marked text", async () => {
  // 造一份最小但合法的 PDF，避免测试依赖网络
  const pdf = await makeOnePagePdf("Codex Paper Reader smoke test");
  const parsed = await extractPdf(pdf);
  assert.equal(parsed.pages, 1);
  assert.match(parsed.text, /===== PAGE 1 =====/);
  assert.match(parsed.text, /smoke test/);
  assert.ok(Array.isArray(parsed.images));
});

test("the server fetches a PDF by URL so the browser need not download it twice", async () => {
  const calls = [];
  const buffer = await fetchPdfByUrl("https://example.org/paper.pdf", {
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return new Response(Buffer.from("%PDF-1.7 remote"), { status: 200 });
    }
  });
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(calls[0].url, "https://example.org/paper.pdf");
  assert.match(calls[0].headers.Referer, /^https:\/\/example\.org\//);
  assert.match(calls[0].headers["User-Agent"], /Chrome/);
});

test("a login-walled URL fails in a way the extension can retry with cookies", async () => {
  await assert.rejects(
    // 必须换一个地址：上一条用例已经把 example.org/paper.pdf 存进缓存了
    () => fetchPdfByUrl("https://example.org/behind-login.pdf", {
      fetchImpl: async () => new Response("login", { status: 403 })
    }),
    /改用浏览器凭据重试/
  );
});

test("file:// URLs are read straight off disk, no browser file permission needed", async () => {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "reader-"));
  const file = join(directory, "local paper.pdf");
  await writeFile(file, "%PDF-1.4 local");
  const buffer = await fetchPdfByUrl(pathToFileURL(file).href);
  assert.equal(buffer.toString("ascii"), "%PDF-1.4 local");

  await assert.rejects(() => fetchPdfByUrl("file:///definitely/missing.pdf"), /读不到这个本地文件/);
});

test("only http, https and file URLs are accepted", async () => {
  await assert.rejects(() => fetchPdfByUrl("ftp://example.org/p.pdf"), /只支持 http/);
  await assert.rejects(() => fetchPdfByUrl("not a url"), /PDF 地址无效/);
});

test("a stale server receiving raw PDF bytes says so instead of blaming the JSON", async () => {
  const server = createServer({ apiKey: "k", extractImpl: async () => SAMPLE_DOCUMENT });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.protocol, PROTOCOL_VERSION, "扩展靠这个字段判断服务端是否过旧");

    // 把 PDF 字节发到一个只收 JSON 的端点：报错必须指向版本，而不是含糊的 JSON 无效
    const response = await fetch(`${base}/api/documents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from("%PDF-1.4 raw bytes")
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /本地服务版本过旧/);
  } finally {
    server.close();
  }
});

test("HTTP server parses an upload and streams a DeepSeek answer", async () => {
  const documentStore = new Map();
  const server = createServer({
    apiKey: "test-key",
    accessToken: "secret-token",
    documentStore,
    extractImpl: async () => SAMPLE_DOCUMENT,
    fetchImpl: async (url, init) => {
      assert.match(url, /\/chat\/completions$/);
      const payload = JSON.parse(init.body);
      assert.equal(payload.stream, true);
      assert.ok(payload.messages[1].content.some((part) => part.type === "image_url"));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"导读"}}]}\n\n'));
          controller.enqueue(Buffer.from('data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"total_tokens":9}}\n\n'));
          controller.enqueue(Buffer.from("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200 });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "X-Reader-Token": "secret-token" };

  try {
    const unauthorized = await fetch(`${base}/health`);
    assert.equal(unauthorized.status, 401);

    const health = await (await fetch(`${base}/health`, { headers: auth })).json();
    assert.equal(health.apiKeyConfigured, true);
    assert.equal(health.model, "deepseek-v4-flash-vision-exp");

    const uploaded = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/pdf" },
      body: Buffer.from("%PDF-1.4 pretend")
    });
    assert.equal(uploaded.status, 201);
    const document = await uploaded.json();
    assert.match(document.fileId, /^doc_[a-f0-9]{32}$/);
    assert.equal(document.title, "A Sample Paper");
    assert.equal(document.imageCount, 1);

    const streamed = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: document.fileId, message: "总结这篇论文" })
    });
    const events = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events[0], { type: "delta", delta: "导读" });
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).truncated, false);

    // 缓存掉了要给 404，扩展据此静默重传
    const stale = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: "doc_deadbeef", message: "问题" })
    });
    assert.equal(stale.status, 404);
  } finally {
    server.close();
  }
});

async function makeOnePagePdf(text) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `
import sys, fitz
doc = fitz.open()
doc.new_page().insert_text((72, 120), sys.argv[1])
sys.stdout.buffer.write(doc.tobytes())
`;
  const { stdout } = await promisify(execFile)(
    process.env.PYTHON || "python3",
    ["-c", script, text],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
  );
  return stdout;
}

/** 上游 402/429 曾经把整个本地服务打死：async 处理器里 return 了没 await 的 promise。 */
test("上游报错只影响这一次请求，服务不会退出", async () => {
  const documentStore = new Map();
  let upstreamCalls = 0;
  const server = createServer({
    apiKey: "test-key",
    documentStore,
    extractImpl: async () => SAMPLE_DOCUMENT,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  // 进程级兜底不能吞掉这次 rejection——它必须先在请求层被处理掉
  const rejections = [];
  const capture = (reason) => rejections.push(reason);
  process.on("unhandledRejection", capture);

  try {
    const uploaded = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: Buffer.from("%PDF-1.4 pretend")
    });
    const { fileId } = await uploaded.json();

    const failed = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, message: "讲讲这篇" })
    });
    assert.equal(failed.status, 402);
    assert.match((await failed.json()).error, /Insufficient Balance/);

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], "402 不该逃成 unhandled rejection");

    // 关键：服务还活着，下一个请求照常服务
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.protocol, 2);

    // 余额恢复后无需重启，同一个进程继续用
    const again = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, message: "再来一次" })
    });
    assert.equal(again.status, 402);
    assert.equal(upstreamCalls, 2);
  } finally {
    process.off("unhandledRejection", capture);
    server.close();
  }
});

test("流已经开始后上游断掉，补一个 error 事件而不是崩在 writeHead 上", async () => {
  const documentStore = new Map();
  const server = createServer({
    apiKey: "test-key",
    documentStore,
    extractImpl: async () => SAMPLE_DOCUMENT,
    // 必须让第一个 chunk 先被消费掉，响应头才会真的发出去；
    // enqueue 后立刻 error 会把排队的 chunk 一起丢掉，测不到这条路径。
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        if (controller.desiredSize === null) return;
        if (!this.sent) {
          this.sent = true;
          controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'));
          return;
        }
        controller.error(new Error("上游连接被重置"));
      }
    }), { status: 200 })
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const uploaded = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: Buffer.from("%PDF-1.4 pretend")
    });
    const { fileId } = await uploaded.json();

    const response = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, message: "讲讲这篇" })
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].delta, "开头");
    assert.equal(events.at(-1).type, "error");

    // 服务还活着
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
  } finally {
    server.close();
  }
});

test("上游限流会自动退避重试，重试成功后用户完全无感", async () => {
  const waits = [];
  let attempts = 0;
  const documentStore = new Map();
  const server = createServer({
    apiKey: "test-key",
    documentStore,
    extractImpl: async () => SAMPLE_DOCUMENT,
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"终于成功"}}]}\n\n'));
          controller.enqueue(Buffer.from('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'));
          controller.close();
        }
      }), { status: 200 });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const uploaded = await fetch(`${base}/api/documents`, {
      method: "POST", headers: { "Content-Type": "application/pdf" }, body: Buffer.from("%PDF-1.4 x")
    });
    const { fileId } = await uploaded.json();
    const response = await fetch(`${base}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, message: "讲讲这篇" })
    });

    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].delta, "终于成功");
    assert.equal(events.at(-1).type, "done");
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [1000, 3000], "应当按 1s、3s 退避");
  } finally {
    server.close();
  }
});

test("余额不足不重试，并给出可直接照做的提示", async () => {
  let attempts = 0;
  const documentStore = new Map();
  const server = createServer({
    apiKey: "test-key",
    documentStore,
    extractImpl: async () => SAMPLE_DOCUMENT,
    sleepImpl: async () => { throw new Error("余额不足不该走重试"); },
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const uploaded = await fetch(`${base}/api/documents`, {
      method: "POST", headers: { "Content-Type": "application/pdf" }, body: Buffer.from("%PDF-1.4 x")
    });
    const { fileId } = await uploaded.json();
    const failed = await fetch(`${base}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, message: "讲讲这篇" })
    });
    assert.equal(failed.status, 402);
    assert.match((await failed.json()).error, /余额不足.*充值.*不需要重启/);
    assert.equal(attempts, 1, "402 只该请求一次");
  } finally {
    server.close();
  }
});

test("同一篇论文第二次读时走缓存，完全不碰网络", async () => {
  const previous = process.env.READER_CACHE_DIR;
  process.env.READER_CACHE_DIR = await mkdtemp(join(tmpdir(), "reader-int-"));

  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 0x20)]);
  let downloads = 0;
  const fetchImpl = async () => {
    downloads += 1;
    return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  };
  const url = "https://arxiv.org/pdf/2602.13344";

  try {
    const first = await fetchPdfByUrl(url, { fetchImpl });
    assert.deepEqual(first, pdf);
    assert.equal(downloads, 1);

    // 第二次：同一个地址
    assert.deepEqual(await fetchPdfByUrl(url, { fetchImpl }), pdf);
    assert.equal(downloads, 1, "第二次不该再下载");

    // 带 .pdf 后缀的等价写法也该命中
    assert.deepEqual(await fetchPdfByUrl(`${url}.pdf`, { fetchImpl }), pdf);
    assert.equal(downloads, 1, "等价写法应当命中同一条缓存");

    // 换一个版本号则是另一篇稿子，必须重新下载
    await fetchPdfByUrl(`${url}v2`, { fetchImpl });
    assert.equal(downloads, 2, "不同版本必须重新下载");

    // cache:false 可以强制绕过
    await fetchPdfByUrl(url, { fetchImpl, cache: false });
    assert.equal(downloads, 3, "cache:false 应当强制走网络");
  } finally {
    if (previous === undefined) delete process.env.READER_CACHE_DIR;
    else process.env.READER_CACHE_DIR = previous;
  }
});
