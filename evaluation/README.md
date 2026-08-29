# Hallucination evaluation

这是论文导读的可复现事实幻觉评测工具。详细定义见 [METHODOLOGY.md](METHODOLOGY.md)。

## 准备 PDF 文本

```bash
python3 -m pip install -r evaluation/requirements.txt
mkdir -p evaluation/cache
curl -L https://arxiv.org/pdf/2603.19775 -o evaluation/cache/2603.19775.pdf
python3 evaluation/scripts/extract_pdf.py \
  evaluation/cache/2603.19775.pdf \
  evaluation/cache/2603.19775.txt
```

`evaluation/cache/` 和 `evaluation/runs/` 均不会提交到 Git。

## 运行同输入模型对比

```bash
node evaluation/scripts/run.mjs \
  --paper editprobe-2603.19775 \
  --models gpt-5.6-luna-none,gpt-5.6-terra-low,deepseek-v4-flash-none,deepseek-v4-pro-high \
  --env /path/to/private/.env \
  --concurrency 2
```

控制台会打印 `run=<RUN_ID>`。随后判分：

```bash
node evaluation/scripts/evaluate.mjs \
  --run <RUN_ID> \
  --paper editprobe-2603.19775 \
  --env /path/to/private/.env
```

评测已经观察到的豆包输出：

```bash
node evaluation/scripts/evaluate.mjs \
  --paper editprobe-2603.19775 \
  --fixture evaluation/fixtures/doubao-editprobe-observed.md \
  --env /path/to/private/.env
```

正式比较至少使用两个独立裁判，然后生成自动汇总：

```bash
node evaluation/scripts/report.mjs \
  --paper editprobe-2603.19775 \
  --runs <API_RUN_ID>,<PRODUCT_RUN_ID> \
  --judges deepseek-v4-pro-none,gpt-5.6-sol-medium \
  --output evaluation/results/editprobe-automatic.md
```

API Key 只从环境变量读取，结果文件不会保存 Key 或请求头。
