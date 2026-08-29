import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readJson, repoRoot } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const paperId = required(args.paper, "--paper");
const runIds = required(args.runs, "--runs").split(",").filter(Boolean);
const judges = (args.judges || "deepseek-v4-pro-none,gpt-5.6-sol-medium").split(",");
if (judges.length !== 2) throw new Error("--judges 必须恰好包含两个裁判 ID。");

const rows = [];
for (const runId of runIds) {
  const paperDir = resolve(repoRoot, "evaluation/runs", runId, paperId);
  const evaluationDir = resolve(paperDir, "evaluations");
  if (!existsSync(evaluationDir)) throw new Error(`找不到评测目录：${evaluationDir}`);
  const candidateIds = [...new Set(
    readdirSync(evaluationDir)
      .filter((name) => name.endsWith(`--${judges[0]}.json`))
      .map((name) => name.slice(0, -(`--${judges[0]}.json`.length)))
  )];
  for (const candidateId of candidateIds) {
    const first = readJson(resolve(evaluationDir, `${candidateId}--${judges[0]}.json`));
    const secondPath = resolve(evaluationDir, `${candidateId}--${judges[1]}.json`);
    if (!existsSync(secondPath)) continue;
    const second = readJson(secondPath);
    const generationPath = resolve(paperDir, `${candidateId}.json`);
    const generation = existsSync(generationPath) ? readJson(generationPath) : null;
    rows.push({
      runId,
      candidateId,
      sourceKind: first.sourceKind,
      durationMs: generation?.durationMs ?? null,
      outputChars: generation?.outputText?.length ?? null,
      atomicClaims: first.metrics.atomicClaims,
      first: first.metrics,
      second: second.metrics,
      agreement: labelAgreement(first, second)
    });
  }
}

rows.sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));
const lines = [
  `# ${paperId} 自动评测汇总`,
  "",
  `- 裁判 A：\`${judges[0]}\``,
  `- 裁判 B：\`${judges[1]}\``,
  "- 本表是机器初判，不等同于人工真值；正式结论必须复核两位裁判的分歧和重大错误。",
  "",
  "| 候选 | 生成耗时 | 原子事实 | A 幻觉率 | B 幻觉率 | 标签一致率 | A/B 关键事实召回 |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows.map((row) => `| ${row.candidateId} | ${duration(row.durationMs)} | ${row.atomicClaims} | ${percent(row.first.hallucinationRate)} | ${percent(row.second.hallucinationRate)} | ${percent(row.agreement)} | ${percent(row.first.keyFactRecall)} / ${percent(row.second.keyFactRecall)} |`),
  ""
];

const outputPath = resolve(args.output || resolve(repoRoot, "evaluation/results", `${paperId}-automatic.md`));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, lines.join("\n"));
console.log(`output=${outputPath}`);

function labelAgreement(first, second) {
  const a = new Map((first.judgment?.judgments || []).map((item) => [String(item.id), item.label]));
  const b = new Map((second.judgment?.judgments || []).map((item) => [String(item.id), item.label]));
  const shared = [...a].filter(([id]) => b.has(id));
  return shared.length ? shared.filter(([id, label]) => b.get(id) === label).length / shared.length : null;
}

function duration(milliseconds) {
  return milliseconds == null ? "—" : `${(milliseconds / 1000).toFixed(1)} s`;
}

function percent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function required(value, name) {
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    parsed[token.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true";
  }
  return parsed;
}
