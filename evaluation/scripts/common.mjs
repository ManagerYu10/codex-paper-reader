import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../..");

export function loadEnvFile(path) {
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function extractReaderPrompt() {
  const source = readFileSync(resolve(repoRoot, "extension/sidepanel.js"), "utf8");
  const match = source.match(/const AUTO_SUMMARY_PROMPT = `([\s\S]*?)`;\n\nconst DEFAULT_SETTINGS/);
  if (!match) throw new Error("无法从 extension/sidepanel.js 提取产品导读 Prompt。");
  return match[1];
}

export async function callConfiguredModel(config, { system = "", user, json = false, maxTokens = 5000, timeoutMs = 600_000 }) {
  const baseUrl = String(process.env[config.base_url_env] || "").replace(/\/+$/, "");
  const apiKey = process.env[config.api_key_env] || "";
  if (!baseUrl || !apiKey) throw new Error(`缺少 ${config.base_url_env} 或 ${config.api_key_env}`);

  const startedAt = Date.now();
  let endpoint;
  let payload;
  if (config.provider === "openai-responses") {
    endpoint = `${baseUrl}/responses`;
    payload = {
      model: config.model,
      instructions: system || undefined,
      input: user,
      reasoning: { effort: config.reasoning_effort || "none" },
      text: { verbosity: json ? "low" : "medium" },
      max_output_tokens: maxTokens,
      store: false
    };
  } else if (config.provider === "chat-completions") {
    endpoint = `${baseUrl}/chat/completions`;
    payload = {
      model: config.model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user }
      ],
      thinking: { type: config.thinking || "disabled" },
      reasoning_effort: config.reasoning_effort || "low",
      max_tokens: maxTokens,
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {})
    };
  } else {
    throw new Error(`未知 provider: ${config.provider}`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${config.id} HTTP ${response.status}: ${safeApiError(raw)}`);
  const data = JSON.parse(raw);
  const outputText = config.provider === "openai-responses"
    ? extractResponsesText(data)
    : String(data.choices?.[0]?.message?.content || "");
  if (!outputText.trim()) {
    const finishReason = data.choices?.[0]?.finish_reason || data.status || "unknown";
    const reasoningChars = String(data.choices?.[0]?.message?.reasoning_content || "").length;
    throw new Error(`${config.id} 返回了空最终文本（finish=${finishReason}, reasoning_chars=${reasoningChars}）。`);
  }
  return {
    outputText,
    responseId: data.id || "",
    responseModel: data.model || config.model,
    systemFingerprint: data.system_fingerprint || "",
    usage: data.usage || null,
    durationMs: Date.now() - startedAt
  };
}

export function parseJsonOutput(text) {
  const trimmed = String(text).trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("模型没有返回可解析的 JSON。");
  }
}

function extractResponsesText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text" || typeof part.text === "string")
    .map((part) => part.text || "")
    .join("");
}

function safeApiError(raw) {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.error?.message || parsed.error || raw).slice(0, 500);
  } catch {
    return String(raw).slice(0, 500);
  }
}
