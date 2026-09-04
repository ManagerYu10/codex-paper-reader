import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  callConfiguredModel,
  loadEnvFile,
  parseJsonOutput,
  readJson,
  repoRoot,
  sha256
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
loadEnvFile(resolve(args.env));

const papers = readJson(resolve(repoRoot, "evaluation/data/papers.json"));
const models = readJson(resolve(repoRoot, "evaluation/models.json"));
const paper = papers.find((item) => item.id === args.paper);
if (!paper) throw new Error(`未知论文：${args.paper}`);
const extractor = models.find((item) => item.id === (args.extractor || "deepseek-v4-pro-none"));
const judge = models.find((item) => item.id === (args.judge || "deepseek-v4-pro-none"));
if (!extractor || !judge) throw new Error("找不到 extractor 或 judge 模型配置。");

const sourceText = readFileSync(resolve(repoRoot, paper.text_path), "utf8");
const candidateRecords = loadCandidates(args, paper);
const evaluationDir = resolve(repoRoot, "evaluation/runs", args.run || "fixture", paper.id, "evaluations");
const intermediateDir = resolve(evaluationDir, "intermediate");
mkdirSync(evaluationDir, { recursive: true });
mkdirSync(intermediateDir, { recursive: true });

await runPool(candidateRecords, Number(args.concurrency || 2), async (candidate) => {
  if (!candidate.outputText) return;
  console.log(`evaluating ${candidate.candidateId}`);
  const claimsCachePath = resolve(intermediateDir, `${candidate.candidateId}--${extractor.id}.claims-v2.json`);
  const cachedClaims = loadCachedJson(claimsCachePath);
  const extracted = cachedClaims || await extractClaims(extractor, candidate.outputText);
  if (!cachedClaims) {
    writeFileSync(claimsCachePath, `${JSON.stringify(extracted, null, 2)}\n`);
  } else {
    console.log(`cache hit ${candidate.candidateId} claims`);
  }
  if (args.extractOnly === "true") {
    console.log(`${candidate.candidateId} extracted_claims=${extracted.data.length}`);
    return;
  }
  const judged = await judgeClaims(judge, extractor, {
    paper,
    sourceText,
    summary: candidate.outputText,
    claims: extracted.data
  });
  writeFileSync(resolve(intermediateDir, `${candidate.candidateId}--${judge.id}.judge-raw.txt`), judged.rawOutput);
  const result = {
    schemaVersion: 1,
    paperId: paper.id,
    candidateId: candidate.candidateId,
    sourceKind: candidate.sourceKind || "api-run",
    candidateMetadata: candidate.metadata || null,
    extractor: extractor.id,
    judge: judge.id,
    outputSha256: sha256(candidate.outputText),
    jsonRepair: {
      claims: extracted.repaired,
      judgment: judged.repaired
    },
    claims: extracted.data,
    judgment: judged.data,
    metrics: computeMetrics(extracted.data, judged.data)
  };
  const outputPath = resolve(evaluationDir, `${candidate.candidateId}--${judge.id}.json`);
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${candidate.candidateId} ${JSON.stringify(result.metrics)}`);
});

console.log(`output=${evaluationDir}`);

async function extractClaims(model, summary) {
  const system = `你是事实评测的数据标注员。把论文导读拆成最小、独立、可验证的原子事实。
不要判断真假，不要把标题、修辞、建议、纯主观评价或明确标为“直觉解释”的类比当作论文事实。
复合句必须拆开；含多个数字的声明通常要按数字关系拆分。
每条 claim 最多包含一个主要谓词或一个可独立核验的数字关系。“精度更高、速度更快”必须拆成两条；“包含512张图、8类任务和10个模型”必须拆成三条。
不要因为两个事实出现在同一句、同一个 bullet 或同一个表格行里就合并。宁可细拆，不要把部分正确、部分错误的内容塞进同一条。
输出 JSON 对象：{"claims":[{"id":"c1","claim":"...","has_number":true,"cited_anchor":"Sec. X / Table Y / page Z / 空字符串","importance":"major|minor"}]}。`;
  const summaryParts = chunkText(summary, 1600);
  const merged = { data: [], repaired: false, rawOutput: "" };
  for (let partIndex = 0; partIndex < summaryParts.length; partIndex += 1) {
    const parsed = await callJson(model, model, {
      system,
      user: `请拆解下面论文导读的第 ${partIndex + 1}/${summaryParts.length} 个片段。只抽取当前片段中明确出现的声明：\n\n${summaryParts[partIndex]}`,
      maxTokens: 5000
    });
    if (!Array.isArray(parsed.data.claims)) throw new Error(`claim extractor 第 ${partIndex + 1} 段缺少 claims 数组。`);
    merged.data.push(...parsed.data.claims);
    merged.repaired ||= parsed.repaired;
    merged.rawOutput += `\n\n===== CLAIM PART ${partIndex + 1} =====\n\n${parsed.rawOutput}`;
  }
  return {
    repaired: merged.repaired,
    rawOutput: merged.rawOutput,
    data: merged.data.map((claim, index) => ({
      id: `c${index + 1}`,
      claim: String(claim.claim || "").trim(),
      has_number: Boolean(claim.has_number),
      cited_anchor: String(claim.cited_anchor || "").trim(),
      importance: claim.importance === "major" ? "major" : "minor"
    })).filter((claim) => claim.claim)
  };
}

async function judgeClaims(model, repairModel, { paper, sourceText, summary, claims }) {
  const system = `你是严格、保守的论文事实核验员。唯一事实来源是提供的论文抽取文本。
逐条判断原子声明：supported=原文明确支持；contradicted=原文明确冲突；not_in_source=原文没有依据；ambiguous=抽取缺损或需要图像/复杂跨段推理，无法可靠判断。
不得凭领域常识补全。数字、模型名、训练参数、数据规模和最高/最好等比较必须精确匹配语义关系。
错误类型只能是 none、entity、relation、number、circumstance、discourse、out_of_source、citation_mismatch。
若声明带引用锚点，还要判断该锚点是否真的支持声明；没带引用则 citation_supported=null。
evidence_quote 最多 20 个英文单词或 30 个汉字，避免长段复制。
最后检查每个 key fact 是否在候选导读中被正确覆盖。
只输出 JSON：{"judgments":[{"id":"c1","label":"supported|contradicted|not_in_source|ambiguous","error_type":"none|entity|relation|number|circumstance|discourse|out_of_source|citation_mismatch","severity":"major|minor","evidence_page":1,"evidence_quote":"...","reason":"...","citation_supported":true}],"key_fact_coverage":[{"id":"...","covered":true,"reason":"..."}]}。`;
  const batchSize = model.provider === "chat-completions" ? 35 : 70;
  const batches = chunk(claims, batchSize);
  const merged = {
    data: { judgments: [], key_fact_coverage: [] },
    repaired: false,
    rawOutput: ""
  };
  for (let index = 0; index < batches.length; index += 1) {
    const user = `论文：${paper.title}\n\nKEY FACTS:\n${JSON.stringify(paper.key_facts || [])}\n\n候选导读全文：\n${summary}\n\n待核验原子声明（第 ${index + 1}/${batches.length} 批）：\n${JSON.stringify(batches[index])}\n\n论文全文抽取文本：\n${sourceText}`;
    const parsed = await callJson(model, repairModel, { system, user, maxTokens: 12000 });
    if (!Array.isArray(parsed.data.judgments)) throw new Error(`judge 第 ${index + 1} 批缺少 judgments 数组。`);
    merged.data.judgments.push(...parsed.data.judgments);
    if (!merged.data.key_fact_coverage.length && Array.isArray(parsed.data.key_fact_coverage)) {
      merged.data.key_fact_coverage = parsed.data.key_fact_coverage;
    }
    merged.repaired ||= parsed.repaired;
    merged.rawOutput += `\n\n===== JUDGE BATCH ${index + 1} =====\n\n${parsed.rawOutput}`;
  }
  return merged;
}

async function callJson(model, repairModel, options) {
  const response = await callConfiguredModel(model, { ...options, json: true });
  try {
    return { data: parseJsonOutput(response.outputText), repaired: false, rawOutput: response.outputText };
  } catch (error) {
    console.warn(`${model.id} JSON 语法无效，调用 ${repairModel.id} 仅修复语法。`);
    const repaired = await callConfiguredModel(repairModel, {
      system: "你是 JSON 语法修复器。只修复用户文本的 JSON 语法，不增删字段、不改写值、不解释。只输出一个合法 JSON 对象。",
      user: response.outputText,
      json: true,
      maxTokens: options.maxTokens
    });
    return { data: parseJsonOutput(repaired.outputText), repaired: true, rawOutput: response.outputText };
  }
}

function loadCachedJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function computeMetrics(claims, judgment) {
  const byId = new Map((judgment.judgments || []).map((item) => [String(item.id), item]));
  const rows = claims.map((claim) => ({ ...claim, ...(byId.get(claim.id) || { label: "ambiguous" }) }));
  const decisive = rows.filter((item) => item.label !== "ambiguous");
  const hallucinated = decisive.filter((item) => ["contradicted", "not_in_source"].includes(item.label));
  const numeric = decisive.filter((item) => item.has_number);
  const numericErrors = numeric.filter((item) => ["contradicted", "not_in_source"].includes(item.label));
  const cited = rows.filter((item) => item.cited_anchor);
  const covered = (judgment.key_fact_coverage || []).filter((item) => item.covered);
  const majorHallucinations = hallucinated.filter((item) => item.severity === "major" || item.importance === "major");
  return {
    atomicClaims: rows.length,
    supportedClaims: rows.filter((item) => item.label === "supported").length,
    contradictedClaims: rows.filter((item) => item.label === "contradicted").length,
    unsupportedClaims: rows.filter((item) => item.label === "not_in_source").length,
    ambiguousClaims: rows.filter((item) => item.label === "ambiguous").length,
    hallucinationRate: ratio(hallucinated.length, decisive.length),
    majorHallucinationRate: ratio(majorHallucinations.length, decisive.length),
    numericErrorRate: ratio(numericErrors.length, numeric.length),
    unsupportedInventionRate: ratio(rows.filter((item) => item.label === "not_in_source").length, decisive.length),
    citationPrecision: ratio(cited.filter((item) => item.citation_supported === true).length, cited.length),
    keyFactRecall: ratio(covered.length, (judgment.key_fact_coverage || []).length),
    manualReviewCount: rows.filter((item) => item.label === "ambiguous" || (["contradicted", "not_in_source"].includes(item.label) && (item.severity === "major" || item.importance === "major"))).length
  };
}

function loadCandidates(options, paper) {
  const records = [];
  if (options.run) {
    const runDir = resolve(repoRoot, "evaluation/runs", options.run, paper.id);
    if (existsSync(runDir)) {
      for (const name of readdirSync(runDir).filter((item) => item.endsWith(".json"))) {
        const record = readJson(resolve(runDir, name));
        if (record.outputText) records.push(record);
      }
    }
  }
  if (options.fixture) {
    records.push({
      candidateId: options.fixtureId || "doubao-extension-1.38.0-observed",
      sourceKind: "observed-product-output",
      metadata: {
        product: "豆包浏览器插件",
        installedExtensionVersionAtAudit: "1.38.0",
        backendModel: "undisclosed-dynamic-route"
      },
      outputText: readFileSync(resolve(options.fixture), "utf8")
    });
  }
  if (options.candidates) {
    const selected = new Set(options.candidates.split(","));
    const filtered = records.filter((item) => selected.has(item.candidateId));
    if (!filtered.length) throw new Error("--candidates 没有匹配任何候选输出。");
    return filtered;
  }
  if (!records.length) throw new Error("没有候选输出；请提供 --run 或 --fixture。");
  return records;
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function chunkText(text, maxChars) {
  const paragraphs = String(text).split(/\n{2,}/).flatMap((paragraph) => {
    if (paragraph.length <= maxChars) return [paragraph];
    return paragraph.split(/(?<=[。！？.!?])\s+/).filter(Boolean);
  });
  const parts = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current);
      current = "";
    }
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) parts.push(current);
  return parts;
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        console.error(`failed ${item.candidateId}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
}

function parseArgs(values) {
  const parsed = {
    env: "/Users/yuzhang/ZhangYu/.env",
    paper: "editprobe-2603.19775"
  };
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) continue;
    parsed[values[index].slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}
