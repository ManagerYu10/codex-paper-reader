# Codex 论文阅读器

一个本地优先的 Chrome / Edge 扩展。从 arXiv 或 PDF 页面一键打开与该论文固定绑定的独立阅读网页，左侧阅读 PDF，右侧自动生成结构化导读并支持追问。

## 已实现

- 在 arXiv 论文详情页和可注入的 PDF 页面显示“GPT 导读”入口，也可直接点击扩展图标
- 每次打开一个独立的双栏阅读 Tab，并把 PDF URL 固定写入页面地址；切换其他标签页不会改变当前论文
- 打开阅读页后自动生成固定结构的论文导读，无需选择模板或点击总结按钮
- 导读与后续回答采用流式输出，模型生成第一段后立即显示并持续渲染 Markdown
- 导读依次包含一句话总结、既有方案痛点、核心工作和分阶段的概念与算法流程，仅在必要时解释公式
- 不生成推荐问题、“值得追问的问题”或继续提问引导
- 精确数字和实现细节需要论文位置锚点；明确区分论文事实、直觉解释和无法确认的信息
- 完整渲染标准 Markdown 标题、加粗、bullet、有序列表、引用、代码和 GitHub 风格表格，并兼容模型偶尔在表格行间加入的单个空行
- 支持网页 PDF、arXiv 直链和本地 PDF
- 通过 OpenAI Responses API 的内联文件输入直接读取 PDF（包括页内文字与图表信息）
- 使用 `previous_response_id` 保持同一篇论文的连续对话
- 每篇论文独立保存本地会话
- API Key 仅放在本机 Node.js 服务，不写入扩展代码或浏览器存储
- 默认使用 GPT‑5.6 Luna + none reasoning，优先降低首字等待；也可选择 Terra/Sol 和 none/low/medium/high 推理强度

## 1. 启动本地服务

需要 Node.js 20 或更新版本，以及一个单独计费的 OpenAI Platform API Key。ChatGPT / Codex 订阅本身不会自动提供 API 额度。

```bash
cd /path/to/codex-paper-reader
export OPENAI_API_KEY="sk-..."
export READER_ACCESS_TOKEN="自己生成一段较长的随机字符串" # 推荐，但可省略
npm start
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

1. 打开 arXiv 论文详情页，点击 `View PDF` 附近的“GPT 导读”；也可以在 PDF 页面点击“GPT 导读”或浏览器工具栏中的扩展图标。
2. 浏览器会新开一个固定绑定当前 PDF 的独立阅读 Tab，左侧为 PDF、右侧为 GPT 导读。
3. 点击右上角设置，确认本地服务地址为 `http://127.0.0.1:8787`。
4. 如果设置了 `READER_ACCESS_TOKEN`，在设置中输入相同口令。
5. 点击“测试连接”并关闭设置；阅读器会自动生成论文导读，首段出现后持续流式显示，完成后可继续自由追问。

Chrome 内置 PDF Viewer 在部分版本中不允许第三方内容脚本修改其内部工具栏；遇到 PDF 页内按钮未出现时，点击浏览器工具栏中的扩展图标即可打开同一个独立阅读页。

## 常见问题

### 当前页面返回的不是 PDF

某些论文网站显示的是带登录态的 HTML 预览页，而不是 PDF 直链。先点击网站的 Download PDF，或把文件下载到本地再打开。

### 本地 PDF 无法读取

到 `chrome://extensions` → 本扩展“详情”，开启“允许访问文件网址”，然后重新加载 PDF。

### 401 或访问口令错误

扩展设置里的访问口令必须和启动服务时的 `READER_ACCESS_TOKEN` 完全一致。

### API Key 从哪里来

在 OpenAI Platform 创建 API Key，并确认 API 项目有可用额度。不要把 Key 填进扩展，也不要提交到 Git。

## 开发与检查

```bash
npm run check
npm test
npm run package:extension
```

打包结果会生成在 `dist/codex-paper-reader-extension.zip`。Chrome 开发者模式仍建议直接加载 `extension` 目录，修改代码后点击“重新加载”即可。

## 数据流与隐私

```text
arXiv / PDF 的“GPT 导读”入口
  → 打开与 PDF URL 固定绑定的独立阅读 Tab
  → 浏览器扩展读取 PDF
  → 127.0.0.1 本地服务
  → 本机内存中的临时 PDF 缓存
  → GPT‑5.6 Luna Responses API（input_file / file_data，流式）
  → 答案实时返回独立阅读页右栏
```

“新会话”会清除本机内存中的临时 PDF 和该论文在扩展里的会话记录。PDF 不会作为持久文件保存到 OpenAI Files API；首次提问时会作为 Responses API 的输入发送给模型。

实现所依据的官方接口：

- [GPT‑5.6 模型选择与推理强度](https://developers.openai.com/api/docs/guides/latest-model)
- [Responses API 的文件输入示例](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)

## License

[MIT](LICENSE)

## 论文事实幻觉评测

仓库包含一套面向论文导读的原子事实评测工具，可比较 GPT、DeepSeek 和豆包产品输出，并分别报告事实幻觉、数字错误、无依据编造、引用准确率和关键事实覆盖率。参见 [evaluation/README.md](evaluation/README.md)。

首轮 EditProbe 试跑已经完成，见 [评测报告](evaluation/results/EDITPROBE_PILOT_2026-08-29.md)。结果包含六档 API 模型、豆包真实输出、双裁判分歧和人工确认的错误下界。
