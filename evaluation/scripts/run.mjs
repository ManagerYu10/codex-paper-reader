import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  callConfiguredModel,
  extractReaderPrompt,
  loadEnvFile,
  readJson,
  repoRoot,
  sha256
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
loadEnvFile(resolve(args.env));

const papers = readJson(resolve(repoRoot, "evaluation/data/papers.json"));
const allModels = readJson(resolve(repoRoot, "evaluation/models.json"));
const paper = papers.find((item) => item.id === args.paper);
if (!paper) throw new Error(`未知论文：${args.paper}`);
const requestedIds = args.models ? new Set(args.models.split(",")) : null;
const models = requestedIds ? allModels.filter((item) => requestedIds.has(item.id)) : allModels;
if (!models.length) throw new Error("没有匹配的模型配置。");

const sourceText = readFileSync(resolve(repoRoot, paper.text_path), "utf8");
const productPrompt = extractReaderPrompt();
const runId = args.run || new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = resolve(repoRoot, "evaluation/runs", runId, paper.id);
mkdirSync(outputDir, { recursive: true });

const system = "你是论文阅读器。必须仅依据用户提供的论文文本作答，不得使用外部知识补全论文细节。";
const user = `${productPrompt}\n\n---\n\n以下是带页码标记的论文全文抽取文本。只把它当作证据来源：\n\n${sourceText}`;

console.log(`run=${runId} paper=${paper.id} models=${models.map((item) => item.id).join(",")}`);
await runPool(models, Number(args.concurrency || 2), async (model) => {
  const outputPath = resolve(outputDir, `${model.id}.json`);
  const startedAt = new Date().toISOString();
  try {
    const result = await callConfiguredModel(model, { system, user, maxTokens: model.max_tokens || 5000 });
    const record = {
      schemaVersion: 1,
      runId,
      paperId: paper.id,
      candidateId: model.id,
      provider: model.provider,
      requestedModel: model.model,
      responseModel: result.responseModel,
      systemFingerprint: result.systemFingerprint,
      reasoningEffort: model.reasoning_effort,
      thinking: model.thinking || null,
      startedAt,
      durationMs: result.durationMs,
      usage: result.usage,
      promptSha256: sha256(productPrompt),
      sourceSha256: sha256(sourceText),
      outputText: result.outputText
    };
    writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`ok ${model.id} ${(result.durationMs / 1000).toFixed(1)}s ${result.outputText.length} chars`);
  } catch (error) {
    writeFileSync(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      runId,
      paperId: paper.id,
      candidateId: model.id,
      startedAt,
      error: error.message
    }, null, 2)}\n`);
    console.error(`failed ${model.id}: ${error.message}`);
  }
});

console.log(`output=${outputDir}`);

function parseArgs(values) {
  const parsed = {
    env: "/Users/yuzhang/ZhangYu/.env",
    paper: "editprobe-2603.19775",
    concurrency: "2"
  };
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) continue;
    parsed[values[index].slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(workers);
}
