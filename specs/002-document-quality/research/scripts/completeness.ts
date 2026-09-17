/**
 * Проверка 5: что из сказанного не попало в готовый документ.
 *
 * Безмодельная сверка (`coverage.ts`) для этого не годится, и это показал
 * замер: она поощряет перенос мусора распознавания и наказывает чистку, то
 * есть измеряет ровно противоположное нужному (results.md, раздел 6). Полноту
 * может сверить только смысл, поэтому здесь ещё одно обращение к модели: она
 * читает расшифровку участка вместе с документом и перечисляет, чего в
 * документе нет.
 *
 * Участок берётся из самого документа — по времени его первого и последнего
 * раздела, — чтобы проверялось ровно то, что модель должна была описать.
 *
 * Запуск:
 *   bun specs/002-document-quality/research/scripts/completeness.ts \
 *     --document data/document-...-A-сегодня.json --transcript 2875806701-1200-5400
 */

import path from "node:path";

const API = "https://openrouter.ai/api/v1/chat/completions";
/** Проверяющий не обязан быть той же моделью, что писала документ. */
const MODEL = arg("model", "meta/muse-spark-1.3-contributor");

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
const documentPath = path.resolve(process.cwd(), arg("document"));
const label = arg("transcript");

interface DocumentFile {
  sections: Array<{ title: string; text: string; startSeconds: number; endSeconds: number }>;
}

const document = (await Bun.file(documentPath).json()) as DocumentFile;
if (document.sections.length === 0) throw new Error("в документе нет разделов");

const from = Math.min(...document.sections.map((section) => section.startSeconds));
const to = Math.max(...document.sections.map((section) => section.endSeconds));

/** Расшифровка режется по времени документа: только то, что он должен был описать. */
const transcript = (await Bun.file(path.join(dataDir, `transcript-${label}.txt`)).text())
  .split("\n")
  .filter((line) => {
    const match = line.match(/^\[(\d+)\]/);
    if (match === null) return false;
    const seconds = Number(match[1]);
    return seconds >= from && seconds <= to;
  })
  .join("\n");

const documentText = document.sections
  .map((section) => `## ${section.title} [${section.startSeconds}—${section.endSeconds}]\n${section.text}`)
  .join("\n\n");

console.log(`участок ${from}–${to} с: расшифровки ${transcript.length} знаков, документа ${documentText.length}`);

const SYSTEM = `Ты сверяешь документ о трансляции с расшифровкой того же участка.

Расшифровка — испорченный вход: в ней есть мусор распознавания, куски на чужом языке и бессмыслица. Их отсутствие в документе потерей не считается, и упоминать их не нужно.

Потерей считается пропущенное содержание: тема, довод, возражение, пример, подробность, оговорка, обещание, срок, обстоятельство или итог, которые прозвучали и в документ не попали.

Перечисли потери списком, каждую одной строкой: что именно сказано и где по времени. Если потерь нет, ответь одним словом: «нет». Ничего кроме списка или этого слова не пиши.`;

const response = await fetch(API, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Расшифровка участка (время в секундах от начала записи):\n\n${transcript}\n\n---\n\nДокумент по этому участку:\n\n${documentText}`,
      },
    ],
  }),
});
if (!response.ok) throw new Error(`модель ответила ${response.status}: ${await response.text()}`);

const body = (await response.json()) as any;
const answer: string = body.choices?.[0]?.message?.content ?? "";
const outPath = `${documentPath.replace(/\.json$/, "")}-потери.txt`;
await Bun.write(outPath, `${answer.trim()}\n`);

console.log(`\nрасход: ${body.usage?.completion_tokens} токенов выхода, ${body.usage?.cost ?? "?"} $`);
console.log(`ответ проверяющего:\n${answer.trim()}`);
console.log(`\nсохранено: ${path.relative(process.cwd(), outPath)}`);
