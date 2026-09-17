/**
 * Проверка 4: что приходит от модели, когда потолок выхода исчерпан.
 *
 * Документ запрашивается в JSON: только так от модели приходят и текст разделов,
 * и время их начала — на размеченном тексте она писала время разнобойно
 * (см. комментарий к `DOCUMENT_SYSTEM_PROMPT`). Отсюда и вопрос: обрыв выхода
 * даёт битый JSON или что-то другое.
 *
 * Замер отвечает на это опытом, а не рассуждением: тот же запрос, что идёт в
 * разборе, но с заведомо малым потолком.
 *
 * Запуск:
 *   bun specs/002-document-quality/research/scripts/truncate.ts --transcript 2875806701-1200-5400
 */

import path from "node:path";
import { DOCUMENT_SYSTEM_PROMPT, buildDocumentPrompt } from "../../../../src/shared/openrouter.ts";

const API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "inclusionai/ling-3.0-flash";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`нужен --${name}`);
  }
  return value;
}

const key = process.env["OPENROUTER_API_KEY"] ?? "";
if (key === "") throw new Error("нет OPENROUTER_API_KEY");

const dataDir = path.resolve(import.meta.dir, "..", "data");
const label = arg("transcript");
const report = (await Bun.file(path.join(dataDir, `transcript-${label}.json`)).json()) as {
  title: string;
  publishedAt: string;
  section: { from: number; to: number };
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number }>;
};
const transcript = (await Bun.file(path.join(dataDir, `transcript-${label}.txt`)).text())
  .split("\n")
  .slice(0, 300)
  .join("\n");

const user = buildDocumentPrompt({
  fullTranscript: transcript,
  part: { startSeconds: report.section.from, endSeconds: report.section.from + 900 },
  streamTitle: report.title,
  publishedAt: report.publishedAt,
  categories: report.chapters,
});

const limits = arg("max-tokens", "300,1500,4000").split(",").map(Number);

for (const maxTokens of limits) {
  const response = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DOCUMENT_SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    console.log(`max_tokens ${maxTokens}: отказ ${response.status} ${(await response.text()).slice(0, 200)}`);
    continue;
  }
  const body = (await response.json()) as any;
  const choice = body.choices?.[0] ?? {};
  const text: string = choice.message?.content ?? "";
  let parsed = "нет";
  try {
    parsed = Array.isArray(JSON.parse(text).sections) ? "да" : "нет разделов";
  } catch {
    parsed = "не разбирается";
  }
  console.log(
    [
      `max_tokens ${maxTokens}:`,
      `остановка ${choice.finish_reason}`,
      `выход ${body.usage?.completion_tokens} (рассуждений ${body.usage?.completion_tokens_details?.reasoning_tokens ?? 0})`,
      `знаков текста ${text.length}`,
      `JSON: ${parsed}`,
    ].join(" | "),
  );
}
