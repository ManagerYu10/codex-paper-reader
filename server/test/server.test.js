import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsePayload,
  createServer,
  decodePdf,
  extractOutputText,
  isAllowedOrigin,
  parseSseEvents
} from "../server.js";

test("decodePdf accepts a PDF signature", () => {
  const encoded = Buffer.from("%PDF-1.7\nminimal test file").toString("base64");
  assert.equal(decodePdf(encoded).subarray(0, 5).toString("ascii"), "%PDF-");
});

test("decodePdf rejects non-PDF content", () => {
  const encoded = Buffer.from("not a pdf").toString("base64");
  assert.throws(() => decodePdf(encoded), /不是有效的 PDF/);
});

test("first response payload attaches the file", () => {
  const pdfBase64 = Buffer.from("%PDF-test").toString("base64");
  const payload = buildResponsePayload({
    fileId: "doc_abc123",
    message: "总结论文",
    model: "gpt-5.6",
    reasoningEffort: "medium"
  }, { filename: "paper.pdf", pdfBase64 });
  assert.equal(payload.model, "gpt-5.6");
  assert.equal(payload.input[0].content[0].type, "input_file");
  assert.equal(payload.input[0].content[0].filename, "paper.pdf");
  assert.equal(payload.input[0].content[0].file_data, `data:application/pdf;base64,${pdfBase64}`);
  assert.equal(payload.previous_response_id, undefined);
  assert.deepEqual(payload.reasoning, { effort: "medium" });
  assert.deepEqual(payload.text, { verbosity: "low" });
});

test("follow-up response payload continues the previous response", () => {
  const payload = buildResponsePayload({
    fileId: "doc_abc123",
    previousResponseId: "resp_abc123",
    message: "实验可靠吗？",
    model: "not-allowed"
  }, { filename: "paper.pdf", pdfBase64: "JVBERi0=" });
  assert.equal(payload.model, "gpt-5.6-luna");
  assert.deepEqual(payload.reasoning, { effort: "none" });
  assert.equal(payload.input, "实验可靠吗？");
  assert.equal(payload.previous_response_id, "resp_abc123");
});

test("extractOutputText combines assistant text blocks", () => {
  const response = {
    output: [{ type: "message", content: [
      { type: "output_text", text: "第一段" },
      { type: "output_text", text: "第二段" }
    ] }]
  };
  assert.equal(extractOutputText(response), "第一段\n\n第二段");
});

test("origin policy accepts Chrome extensions and rejects websites", () => {
  assert.equal(isAllowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
});

test("parseSseEvents handles events split across network chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_'));
      controller.enqueue(encoder.encode('text.delta","delta":"第一段"}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  const events = [];
  for await (const event of parseSseEvents(stream)) events.push(event);
  assert.deepEqual(events, [{ type: "response.output_text.delta", delta: "第一段" }]);
});

test("HTTP server authenticates the extension and proxies upload plus chat", async (t) => {
  const upstreamRequests = [];
  const fakeFetch = async (url, init) => {
    upstreamRequests.push({ url, init });
    if (url.endsWith("/responses")) {
      if (JSON.parse(init.body).stream) {
        const encoder = new TextEncoder();
        const chunks = [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream123"}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"论文"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"导读"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream123","usage":{"total_tokens":42}}}\n\n'
        ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          }
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({
        id: "resp_upstream123",
        output: [{ type: "message", content: [{ type: "output_text", text: "论文摘要" }] }]
      });
    }
    return Response.json({ error: { message: "unexpected request" } }, { status: 404 });
  };

  const server = createServer({ apiKey: "sk-test", accessToken: "reader-secret", fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  const unauthorized = await fetch(`${baseUrl}/health`, { headers: { Origin: extensionOrigin } });
  assert.equal(unauthorized.status, 401);

  const headers = {
    Origin: extensionOrigin,
    "Content-Type": "application/json",
    "X-Reader-Token": "reader-secret"
  };
  const health = await fetch(`${baseUrl}/health`, { headers });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).apiKeyConfigured, true);

  const pdfBase64 = Buffer.from("%PDF-1.7\nintegration test").toString("base64");
  const upload = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filename: "paper.pdf", pdfBase64 })
  });
  assert.equal(upload.status, 201);
  const uploadedDocument = await upload.json();
  assert.match(uploadedDocument.fileId, /^doc_/);

  const chat = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId: uploadedDocument.fileId, message: "总结" })
  });
  assert.equal(chat.status, 200);
  assert.deepEqual(await chat.json(), {
    responseId: "resp_upstream123",
    outputText: "论文摘要",
    usage: null
  });
  assert.equal(upstreamRequests.length, 1);
  assert.match(upstreamRequests[0].url, /\/responses$/);
  const upstreamPayload = JSON.parse(upstreamRequests[0].init.body);
  assert.match(upstreamPayload.input[0].content[0].file_data, /^data:application\/pdf;base64,/);

  const streamChat = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId: uploadedDocument.fileId, message: "重新总结" })
  });
  assert.equal(streamChat.status, 200);
  assert.match(streamChat.headers.get("content-type"), /application\/x-ndjson/);
  const streamEvents = (await streamChat.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(streamEvents, [
    { type: "delta", delta: "论文" },
    { type: "delta", delta: "导读" },
    { type: "done", responseId: "resp_stream123", usage: { total_tokens: 42 } }
  ]);
  assert.equal(JSON.parse(upstreamRequests[1].init.body).stream, true);

  const cleanup = await fetch(`${baseUrl}/api/documents/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId: uploadedDocument.fileId })
  });
  assert.equal(cleanup.status, 200);
  assert.equal((await cleanup.json()).deleted, true);
});
