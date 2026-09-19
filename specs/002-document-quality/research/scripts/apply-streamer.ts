/**
 * Переносит правку документа в хранилища.
 *
 * Правленый документ лежит в `/tmp/<vodId>.after.md` — его кладёт
 * `rewrite-streamer.ts`, и только после того, как сверка покажет, что
 * изменились одни лишь заменяемые слова.
 *
 * Кладётся в два места, и это не дублирование: текст раздела живёт ещё и в
 * метаданных каждого куска, потому что иначе каждая строка выдачи требовала бы
 * отдельного обращения к реестру. Обнови один документ — и выдача отвечала бы
 * старым текстом, а документ показывал новый.
 *
 * Запуск: bun apply-streamer.ts <vodId>
 */

import { Redis } from "@upstash/redis/cloudflare";
import { Bucket } from "@upstash/blob";
import { Index } from "@upstash/vector";

const [, , vodId] = process.argv;
if (vodId === undefined) throw new Error("нужен идентификатор записи");

const bucket = new Bucket({ token: process.env["UPSTASH_BLOB_TOKEN"] ?? "" });
const index = new Index({
  url: process.env["UPSTASH_VECTOR_REST_URL"] ?? "",
  token: process.env["UPSTASH_VECTOR_REST_TOKEN"] ?? "",
});
const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});

const path = `streams/${vodId}.md`;
const before = await new Response((await bucket.get(path)).body).text();
const after = await Bun.file(`/tmp/${vodId}.after.md`).text();

/**
 * Разделы правленого документа по порядку — ровно так же, как их клал разбор:
 * заголовок в квадратных скобках со временем, следом текст до следующего.
 */
function sectionsOf(markdown: string): string[] {
  const parts = markdown.split(/^## /m).slice(1);
  return parts.map((part) => part.split("\n").slice(1).join("\n").trim());
}

const sections = sectionsOf(after);
console.log(`${vodId}: разделов в документе — ${sections.length}`);

// Копия прежнего документа остаётся рядом: перебрать заново всегда можно, но
// сравнить «до» и «после» потом будет уже не с чем.
await Bun.write(`/tmp/${vodId}.before.md`, before);

await bucket.put(path, after, { contentType: "text/markdown; charset=utf-8", cache: "no-store", multipart: true });
console.log("документ записан");

let updated = 0;
let cursor = "0";
do {
  const page: {
    nextCursor: string;
    vectors: Array<{ id: string; metadata?: Record<string, unknown> }>;
  } = await index.range({ cursor, limit: 100, prefix: `${vodId}:`, includeMetadata: true });
  for (const vector of page.vectors) {
    const sectionIndex = Number(vector.id.split(":")[1]);
    const text = sections[sectionIndex];
    if (text === undefined || vector.metadata === undefined) continue;
    if (vector.metadata["sectionText"] === text) continue;
    await index.update({ id: vector.id, metadata: { ...vector.metadata, sectionText: text } });
    updated += 1;
  }
  cursor = page.nextCursor;
} while (cursor !== "");

console.log(`кусков обновлено: ${updated}`);
console.log("осталось «стример» в документе:", (after.match(/[Сс]тример/gi) ?? []).length);
