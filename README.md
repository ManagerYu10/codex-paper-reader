# DeepSeek 论文阅读器

一个本地优先的 Chrome / Edge 扩展。从 arXiv 或 PDF 页面一键打开与该论文固定绑定的独立阅读网页，左侧读 PDF，右侧自动生成结构化导读并支持追问。

论文**在本机解析**：PyMuPDF 抽出带页码标记的全文，含图表的页额外渲染成原图，两者一起送进 DeepSeek 多模态模型。原始 PDF 不会发给模型服务商。

## 已实现

- 在 arXiv 论文详情页和可注入的 PDF 页面显示“论文导读”入口，也可直接点击扩展图标
- PDF 页上的悬浮按钮会**自动探测并避开页面上已有的浮动控件**（豆包悬浮球、截图按钮、翻译条等），
  层级刻意比别家低一档，万一重叠也不会吃掉对方的点击；可拖动，拖过之后位置固定不再自动让位
- 每次打开一个独立的双栏阅读 Tab，并把 PDF URL 固定写入页面地址；切换其他标签页不会改变当前论文
- 打开阅读页后自动生成固定结构的论文导读，无需选择模板或点击总结按钮
- 导读与后续回答采用流式输出；**往上翻阅时不会被拽回底部**，只有贴着底部才跟随生成
- 生成过程中可随时**停止**，输入框保持可用，能先把下一个问题打好
- 状态栏显示“已送入模型：N 页 · N 字符 · N 张图表页”，可直接核对模型到底收到了什么
- 本地论文缓存失效时**自动重新解析并重试**，不需要手动点“重新总结”
- 标题以本地 PyMuPDF 从 PDF 里抽出的真标题为准，重开已读过的论文不会退回 URL 猜出来的名字；
  真标题拿到之前按 arXiv 编号等可辨识的兜底显示
- **PDF 由本地服务直接取回**，浏览器不再为了喂模型重复下载一整份；`file://` 直接读磁盘
- 服务端取不到（需要登录、被人机验证挡）时自动退回浏览器用登录态下载，最后可回退到“改为选择本地 PDF”
- 导读章节**跟着论文走**：先判断这篇的重心（模型结构、数据流水线、评测基准、理论分析……），
  再决定分几个小节、叫什么名字；主图和关键表格会被点名，方便照着论文对读
- 固定回答每篇都该回答的问题：一句话总结、既有方案痛点、核心工作、它是怎么做的、效果、局限与存疑、后续方向
- 导读顶部自动生成**目录**，由实际写出的二级标题派生，点击跳转到对应章节
- 导读按**速读**写：论证用连贯段落而不是词条清单；论文自造的概念先用日常语言讲明白再给英文缩写；
  只保留本身就是结论的数字，页码锚点一段最多一次；一句话总结里不出现缩写、数字和括号
- 不生成推荐问题、“值得追问的问题”或继续提问引导
- 精确数字和实现细节需要论文位置锚点；明确区分论文事实、直觉解释和无法确认的信息
- 完整渲染标准 Markdown 标题、加粗、bullet、有序列表、引用、代码和 GitHub 风格表格
- 支持网页 PDF、arXiv 直链和本地 PDF；扫描件自动退化为整页视觉阅读
- API Key 仅放在本机 Node.js 服务，不写入扩展代码或浏览器存储
- **上游出错不会打死本地服务**：余额不足、限流、鉴权失败、网络抖动、浏览器中途关页，
  都只影响当次请求；限流和 5xx 会按 1 秒、3 秒自动退避重试，余额和鉴权错误不重试并直接给出该怎么办

## 1. 启动本地服务

需要 Node.js 20+、Python 3 和 PyMuPDF，以及一个 DeepSeek Platform API Key。

```bash
cd /path/to/codex-paper-reader
python3 -m pip install pymupdf

export DEEPSEEK_API_KEY="sk-..."
export READER_ACCESS_TOKEN="自己生成一段较长的随机字符串" # 推荐，但可省略
npm start
```

启动日志会打印 `PDF extractor: PyMuPDF ready`。如果打印 MISSING，说明 `python3 -m pip install pymupdf` 没装上，PDF 无法解析。

**改完服务端代码一定要重启。** Node 把旧代码常驻在内存里，只改文件不生效，扩展会报
「本地服务是旧版本，和当前扩展对不上」。端口被占时启动日志会直接告诉你怎么停：

```bash
lsof -ti tcp:8787 | xargs kill
```

服务默认只监听 `127.0.0.1:8787`。不要把 `HOST` 改成公网地址。

## 2. 安装浏览器扩展

1. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目的 `extension` 目录。
5. 把扩展固定到工具栏。
6. 如果要读本地 PDF，在扩展详情页开启“允许访问文件网址”。

## 3. 第一次使用

1. 打开 arXiv 论文详情页，点击 `View PDF` 附近的“论文导读”；也可以在 PDF 页面点击悬浮按钮或浏览器工具栏中的扩展图标。
2. 浏览器会新开一个固定绑定当前 PDF 的独立阅读 Tab，左侧为 PDF、右侧为导读。
3. 点击右上角设置，确认本地服务地址为 `http://127.0.0.1:8787`。
4. 如果设置了 `READER_ACCESS_TOKEN`，在设置中输入相同口令。
5. 点击“测试连接”并关闭设置；阅读器会自动解析论文并流式生成导读。

悬浮按钮和别的扩展打架时，**按住拖到顺手的位置**即可，位置会记住。

Chrome 内置 PDF Viewer 在部分版本中不允许第三方内容脚本注入；PDF 页内按钮未出现时，点击浏览器工具栏中的扩展图标即可打开同一个独立阅读页。

## 常见问题

### 当前页面返回的不是 PDF

某些论文网站显示的是带登录态的 HTML 预览页，或有人机验证。先点击网站的 Download PDF，再用阅读页里的“改为选择本地 PDF”。

### 本地 PDF 无法读取

本地服务会直接从磁盘读 `file://`，通常不需要额外权限。左栏预览要显示 PDF 才需要在
`chrome://extensions` → 本扩展“详情”里开启“允许访问文件网址”。都不行就用“改为选择本地 PDF”。

### 启动日志显示 PDF extractor: MISSING

运行 `python3 -m pip install pymupdf`。如果 `python3` 不在 PATH 或想指定虚拟环境，设置 `PYTHON=/path/to/python`。

### Insufficient Balance / 余额不足

DeepSeek 账户没钱了，到 platform.deepseek.com 充值即可，**本地服务不需要重启**。
以前这个错误会让服务进程直接退出，现在只影响当次请求。

### 401 或访问口令错误

扩展设置里的访问口令必须和启动服务时的 `READER_ACCESS_TOKEN` 完全一致。

## 开发与检查

自动导读用的 prompt 逐字收录在 [docs/prompt.md](docs/prompt.md)。那份是**派生文件**——
唯一事实来源是 `extension/sidepanel.js` 里的 `AUTO_SUMMARY_PROMPT`，改完跑 `npm run sync:prompt`，
两边不一致时 `npm run check` 会直接报错。

```bash
npm run check   # 静态守卫：架构不变量、UI 绑定、Manifest、prompt 文档是否同步
npm test        # 50 个测试，不需要网络和 API Key
npm run package:extension
```

`npm test` 里的 `extension/test/reader.test.js` 用一份最小 DOM / chrome 桩
（`extension/test/harness/dom.mjs`）把 `sidepanel.js` 的真实代码跑起来打一个假的本地服务，
覆盖自动导读、追问带历史、缓存失效自动重传、滚动跟随、停止生成和新扩展对上旧服务这几条路径。

打包结果会生成在 `dist/codex-paper-reader-extension.zip`。Chrome 开发者模式仍建议直接加载 `extension` 目录，修改代码后点击“重新加载”即可。

## 数据流与隐私

```text
arXiv / PDF 的“论文导读”入口
  → 打开与 PDF URL 固定绑定的独立阅读 Tab
  → 阅读页把 PDF 的 URL 交给 127.0.0.1 本地服务，由服务自己取回
     （拿不到时才退回浏览器用登录态下载，再以二进制 POST 过去）
  → 本地 PyMuPDF：抽带页码标记的全文 + 渲染含图表的页为 JPEG
  → 校验确实解析出了内容，否则当场报错
  → DeepSeek /chat/completions（文本 + 页面图，流式）
  → 答案实时返回独立阅读页右栏
```

原始 PDF 只在本机内存中停留，不会发给模型服务商；送出去的是抽取后的文字和渲染出的页面图。
“重新总结”会清除本机内存中的临时解析结果和该论文在扩展里的会话记录。

追问时论文那一轮内容固定不变，因此会命中 DeepSeek 的上下文缓存——实测 34 页论文的追问有约 86% 的 prompt token 走缓存。

### 为什么不直接把 PDF 发给模型

DeepSeek 的 `chat/completions` 只接受 `text`、`image_url` 和 `file` 三种内容块，其中 `file` 明确只收 `webp / png / jpeg / gif`：

```text
{"error":{"message":"You have uploaded an unsupported file. Please make sure your file
is valid and has one of the following formats: webp, png, jpeg, and gif."}}
```

所以图表信息只能靠本地渲染页面图带进去。这样做顺带解决了旧版把整个 PDF 内联进请求体的问题——46 MB 的论文 base64 后是 62 MB，会被上游静默丢弃，模型收到空文件却不会报错。

### 下载为什么还要等

模型要读的是全文和图表页，字节必须先到本地服务。这一步是带宽决定的——46 MB 的论文按 2 MB/s 算就是 20 秒出头，
换谁下都一样。能省的是**下两遍**：现在由本地服务取一次，左栏 iframe 仍按需渐进渲染，不再整份重复下载。

## 已知限制

- `deepseek-v4-flash-vision-exp` 是实验性接口，官方可能改行为或下线。届时把 `READER_MODEL` 换成 `deepseek-v4-flash` 可以继续用，但只剩纯文本，读不到图表。
- 单篇最多渲染 12 张图表页（`server/extract.py` 的 `MAX_IMAGES`）。图特别多的论文，靠后的附录图不会送进模型。
- 图表页的挑选靠“有 Figure/Table 题注 + 有大图或大量矢量绘制”启发式判断，可能漏掉纯文字排版的表格——不过这类表格的文字本来就在全文里。

## License

[MIT](LICENSE)

## 论文事实幻觉评测

仓库包含一套面向论文导读的原子事实评测工具，可比较 GPT、DeepSeek 和豆包产品输出，并分别报告事实幻觉、数字错误、无依据编造、引用准确率和关键事实覆盖率。参见 [evaluation/README.md](evaluation/README.md)。

注意评测链路是**纯文本**的（喂 `extract_pdf.py` 抽出的 .txt），不发页面图；它衡量的是同输入下不同模型的表现，不等于阅读器实际的多模态效果。

首轮 EditProbe 试跑已经完成，见 [评测报告](evaluation/results/EDITPROBE_PILOT_2026-08-29.md)。结果包含六档 API 模型、豆包真实输出、双裁判分歧和人工确认的错误下界。
