# AGENTS.md — codex-paper-reader

本文件是本 Repo 的共享主规则，继承 [`../AGENTS.md`](../AGENTS.md) 的通用约定。

## 一、这是工具仓库，不是调研仓库

`self_learning/AGENTS.md` 第六节那套「调研 Repo 形态」（`papers/YYYY-MM_简称/解读.md`、
`scripts/papers.json`、CC BY 4.0）**不适用于本 Repo**。这里是一个 Chrome 扩展加本地 Node
服务的工具项目，License 是 MIT。

**远端 `ManagerYu10/codex-paper-reader` 保持 public，这是有意为之**，不要按调研仓库的
private 约定去改它。改变可见性前仍须取得用户确认。

## 二、模型和凭证

凭证唯一位置是 `/Users/yuzhang/ZhangYu/.env`。**不要把密钥复制进本 Repo**，运行时读。

| 变量 | 值 |
| --- | --- |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| `READER_MODEL` | `deepseek-v4-flash-vision-exp` |
| `DEEPSEEK_API_KEY` | 见 .env |

`deepseek-v4-flash-vision-exp` 是**唯一能收 `image_url` 的 DeepSeek 模型**，也是实验接口，
官方可能下线。换成 `deepseek-v4-flash` 可以继续跑，但只剩纯文本，读不到图表。

备选服务商实测（同一份论文页面图）：Gemini 3.7 Flash 能读图但首字慢约 9 倍、贵约 4.5 倍；
Qwen 系列能读图但慢；**混元 hy3 会静默丢图**（HTTP 200、不报错、`prompt_tokens` 只有几十），
不要用。Gemini 不接受请求体里 DeepSeek 专有的 `thinking` 字段。

## 三、启动与验收

```bash
set -a && . ~/ZhangYu/.env && set +a && npm start   # 本地服务，只监听 127.0.0.1:8787
npm run check    # 静态守卫：架构不变量、prompt 规则、UI 绑定、Manifest
npm test         # 53 个测试，不需要网络和 API Key
```

提交前 `npm run check` 和 `npm test` 都必须过。**`git push` 是对外动作，要先问用户。**

## 四、改完必须重启/重载什么

这是本 Repo 最常浪费时间的地方，三条链路互相独立：

| 改了什么 | 必须做什么 |
| --- | --- |
| `server/**` | **重启 `npm start`**。Node 把旧代码常驻内存，改文件不生效，扩展会报「本地服务是旧版本」 |
| `extension/**` | `chrome://extensions` 刷新扩展，**然后再刷新已经开着的阅读页 Tab**。刷扩展不会重载已载入的页面 |
| `AUTO_SUMMARY_PROMPT` | 上面两步之后，还要在阅读页点**「重新总结」**——已有会话会被恢复，不会自动重跑 |

端口被占时启动日志会直说怎么停：`lsof -ti tcp:8787 | xargs kill`。

## 五、会咬人的坑

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| prompt 里写了裸反引号 | `AUTO_SUMMARY_PROMPT` 是反引号模板串，会被提前终止；**偶数个反引号还能重新配对成合法代码**，`node --check` 一路绿灯，只有跑测试才炸 | 绝不在 prompt 里用反引号；`npm run check` 已有守卫 |
| async 处理器 `return` 了没 `await` 的 promise | rejection 绕过 try/catch 成 unhandled rejection，**上游一次 402 打死整个服务** | 一律 `return await`；守卫检查 `return await streamChat` |
| 测试写进真实 PDF 缓存 | 前一条用例存下的 PDF 让后一条永远命中缓存，还污染 `.cache/pdfs` | `server/test/server.test.js` 顶层已把 `READER_CACHE_DIR` 指向临时目录；新增用例别再自己造目录 |
| 测试用例共用同一个 URL | 缓存命中让「登录墙应当报错」这类用例走不到目标分支 | 每条用例用不同的 URL |
| harness 桩接得不对但不报错 | 例如 `insertAdjacentHTML` 曾无视 `position` 一律追加，让断言假通过 | 桩不支持的用法直接抛错，不要静默降级 |

## 六、三层缓存，语义各不相同

| 层 | 存在哪 | 活多久 | 「重新总结」 |
| --- | --- | --- | --- |
| PDF 字节 | 磁盘 `.cache/pdfs/` | 长期，重启服务也在 | 保留，不重新下载 |
| 解析结果（全文 + 图表页） | 服务内存，最多 6 篇 | 重启即丢 | 删掉，重新解析（约 2 秒） |
| 导读与对话 | 浏览器 `chrome.storage.local` | 按论文 URL 长期保存 | 删掉 |

`READER_CACHE_DIR` / `READER_CACHE_MB` 可调，设 `0` 关闭。arXiv 的 `v1` 和 `v2` **不共用缓存**，
合并会读到错的那一版。

## 七、导读 prompt 的不变量

`AUTO_SUMMARY_PROMPT` 在 `extension/sidepanel.js`，是唯一事实来源；
`docs/prompt.md` 是**派生文件**，改完跑 `npm run sync:prompt`，不同步 `npm run check` 会红。

已经通过守卫固化、不要随手改掉的规则：

- **章节结构跟着论文走**，不写死模板——数据流水线、评测基准常常才是主贡献，套模板会整章漏掉。
- 二级标题固定回答每篇都该回答的问题；**三级小节由论文决定**，标题自拟。
- 自造概念**先说人话再给缩写**；论文没展开的缩写照抄，**不猜**（曾把 DPO 猜成「差分隐私」）。
- 数字只在「效果如何」一节鼓励给；页码锚点一段最多一次，但**图表编号不受此限**。
- 每条 bullet：**加粗一句论点 + 一到两句解释，最多三句**。
- 大白话解释必须写成 Markdown 引用（行首大于号）。
- **写完整比写短重要**——硬卡字数会让模型写到一半收手，留下没写完的章节。
- 不生成「值得追问的问题」「推荐问题」这类结尾。

## 八、事实纪律

涉及模型能力、定价、接口行为的结论，**先实测或查官方页面，再写进文档**。本 Repo 里这类结论
（多模态支持、丢图行为、缓存命中率、耗时）都来自实测，不要用记忆替换。拿不准就标注未验证。
