import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PDF = (tag) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(tag.padEnd(64, " "))]);

async function freshCache() {
  const dir = await mkdtemp(join(tmpdir(), "reader-cache-"));
  process.env.READER_CACHE_DIR = dir;
  delete process.env.READER_CACHE_MB;
  return dir;
}

// 每个用例要一份干净的模块状态；缓存目录靠环境变量在调用时读取，所以复用模块也安全
const cache = await import("../pdf-cache.js");

test("同一篇论文的几种写法命中同一条缓存，但版本号不能串味", async () => {
  const { cacheKey } = cache;
  const bare = cacheKey("https://arxiv.org/pdf/2602.13344");
  assert.equal(bare, cacheKey("https://arxiv.org/pdf/2602.13344.pdf"), "带不带 .pdf 应当同键");
  assert.equal(bare, cacheKey("https://ArXiv.org/pdf/2602.13344/"), "大小写和结尾斜杠应当同键");
  assert.equal(bare, cacheKey("https://arxiv.org/pdf/2602.13344#page=3"), "锚点应当忽略");

  // v1 和 v2 是不同的稿子，合并会读到错的那一版
  assert.notEqual(bare, cacheKey("https://arxiv.org/pdf/2602.13344v2"));
  assert.notEqual(cacheKey("https://arxiv.org/pdf/2602.13344v1"), cacheKey("https://arxiv.org/pdf/2602.13344v2"));

  // 别的站点的查询串是身份的一部分，不能丢
  assert.notEqual(cacheKey("https://openreview.net/pdf?id=aaa"), cacheKey("https://openreview.net/pdf?id=bbb"));

  // file:// 和非法地址不参与缓存
  assert.equal(cacheKey("file:///Users/me/paper.pdf"), null);
  assert.equal(cacheKey("不是地址"), null);
});

test("写进去能读出来，非 PDF 内容不写", async () => {
  await freshCache();
  const { readCached, writeCached } = cache;
  const url = "https://example.org/a.pdf";

  assert.equal(await readCached(url), null, "空缓存应当未命中");
  assert.equal(await writeCached(url, PDF("hello")), true);
  assert.deepEqual(await readCached(url), PDF("hello"));

  // 上游返回了 HTML 挡板页时不能当 PDF 存下来
  assert.equal(await writeCached("https://example.org/b.pdf", Buffer.from("<html>登录</html>")), false);
  assert.equal(await readCached("https://example.org/b.pdf"), null);
});

test("上次写到一半留下的半截文件不算命中，会被清掉重下", async () => {
  const dir = await freshCache();
  const { readCached, writeCached, cacheKey } = cache;
  const url = "https://example.org/broken.pdf";
  await writeCached(url, PDF("good"));

  // 模拟进程被杀留下的残缺文件
  await writeFile(join(dir, `${cacheKey(url)}.pdf`), Buffer.from("%PD"));
  assert.equal(await readCached(url), null, "残缺文件不该被当成命中");
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".pdf")), [], "应当把坏文件删掉");
});

test("超出容量上限时按最久未用淘汰", async () => {
  const dir = await freshCache();
  const { writeCached, readCached, evict, cacheKey } = cache;
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(400 * 1024, 0x41)]);

  for (const name of ["old", "mid", "new"]) await writeCached(`https://example.org/${name}.pdf`, big);

  // 人为拉开访问时间，让 old 最久未用
  const now = Date.now();
  for (const [name, ageMs] of [["old", 9e6], ["mid", 5e6], ["new", 0]]) {
    const when = new Date(now - ageMs);
    await utimes(join(dir, `${cacheKey(`https://example.org/${name}.pdf`)}.pdf`), when, when);
  }

  await evict(900 * 1024);   // 只放得下两篇
  assert.equal(await readCached("https://example.org/old.pdf"), null, "最久未用的应当被删");
  assert.ok(await readCached("https://example.org/new.pdf"), "最近用过的应当保留");
});

test("READER_CACHE_MB=0 时完全关闭缓存", async () => {
  await freshCache();
  process.env.READER_CACHE_MB = "0";
  const { writeCached, readCached } = cache;
  assert.equal(await writeCached("https://example.org/off.pdf", PDF("x")), false);
  assert.equal(await readCached("https://example.org/off.pdf"), null);
  delete process.env.READER_CACHE_MB;
});
