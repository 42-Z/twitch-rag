/**
 * Правка готового документа: стример называется по имени, а не по роли.
 *
 * Нужна для документов, разобранных до того, как это правило появилось в
 * инструкции. Перебирать их целиком незачем — расшифровки уже нет, а правка
 * одна и та же.
 *
 * Замена не механическая. Слово «стример» в документах значит и владельца
 * канала, и стримеров вообще («стримерской тусовки», «стать стримером»), и
 * других людей. Поэтому места разбираются по смыслу, а не заменой по образцу.
 *
 * Что бы модель ни вернула, результат сверяется построчно: измениться должны
 * только эти слова и ничто больше. Не сошлось — правка не принимается.
 *
 * Запуск: bun rewrite-streamer.ts <vodId>
 */

import { Redis } from "@upstash/redis/cloudflare";
import { Bucket } from "@upstash/blob";

const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
const model = "meta/muse-spark-1.3-contributor";

const SYSTEM = `Ты правишь готовый документ о трансляции с Twitch. Ведущий канала — 5opka.

# Задача

Замени слова, которые называют ведущего по роли, на его имя. «Стример начинает собирать сервер» → «5opka начинает собирать сервер». «Стримера» → «5opka», «стримеру» → «5opka», «стримером» → «5opka»: имя не склоняется.

# Что заменять НЕ надо

Слово «стример» в документе значит не только ведущего:

- стримеры вообще: «стримерской тусовки», «топовые стримеры», «не стримеров», «стать стримером», «стримерство для души»;
- другие люди: гость, собеседник, тот, о ком говорят, — если по смыслу это не ведущий канала;
- составные названия и обороты, где «стример» — часть понятия, а не обращение к человеку.

Такие места оставь как есть, слово в слово.

# Чего делать нельзя

Правится ровно одно: как назван ведущий. Больше НИЧЕГО не меняется — ни слова, ни порядок, ни знаки препинания, ни пробелы, ни заголовки. Не сокращай, не дописывай, не переписывай обороты, не поправляй ошибки.

# Форма ответа

Ответ — весь документ целиком, знак в знак, и ничего вокруг: без пояснений, без оговорок, без обратных кавычек и без вступлений.`;

const [, , vodId] = process.argv;
if (vodId === undefined) throw new Error("нужен идентификатор записи");

const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});
const bucket = new Bucket({ token: process.env["UPSTASH_BLOB_TOKEN"] ?? "" });

const record = await redis.hgetall<Record<string, unknown>>(`stream:${vodId}`);
if (record === null) throw new Error(`записи ${vodId} нет в реестре`);
const path = `streams/${vodId}.md`;
const before = await new Response((await bucket.get(path)).body).text();

const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    model,
    max_completion_tokens: 200000,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: before },
    ],
  }),
});
const payload = (await response.json()) as {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { cost?: number };
};
const after = (payload.choices?.[0]?.message?.content ?? "").replace(/^```(?:markdown|md)?\n|\n```$/g, "");

/**
 * Сверка: измениться должны только интересующие нас слова.
 *
 * Сравниваются последовательности слов — всё прочее обязано совпасть место в
 * место. Так любая правка, которой мы не просили, видна сразу: модель охотно
 * «улучшает» текст, а документ — не её черновик, а запись эфира.
 */
function differences(from: string, to: string): string[] {
  // Пустые куски выбрасываются: пробелы и переводы строк правкой не считаются,
  // а без этого хвостовой пробел выглядел бы как убранное слово.
  const a = from.split(/\s+/).filter((word) => word !== "");
  const b = to.split(/\s+/).filter((word) => word !== "");
  const out: string[] = [];
  // Меняется само слово, а всё прилипшее к нему — точка, запятая, кавычка —
  // остаётся на месте: «стримера.» → «5opka.», а не «5opka».
  const expected = (was: string, now: string): boolean =>
    /^[Сс]тример/i.test(was) &&
    /^5opka/i.test(now) &&
    was.replace(/^[Сс]тример[а-я]*/i, "") === now.replace(/^5opka/i, "");
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    // Расхождение: ищем, где последовательности снова сходятся, — тогда
    // видно, что именно пропало или появилось, а не «всё поехало».
    let settled = false;
    for (let w = 1; w <= 15 && !settled; w += 1) {
      if (a[i + w] === b[j]) {
        out.push(`убрано: «${a.slice(i, i + w).join(" ")}»`);
        i += w;
        settled = true;
      } else if (a[i] === b[j + w]) {
        out.push(`добавлено: «${b.slice(j, j + w).join(" ")}»`);
        j += w;
        settled = true;
      }
    }
    if (settled) continue;

    const was = a[i] ?? "";
    const now = b[j] ?? "";
    if (!expected(was, now)) out.push(`«${was}» → «${now}»`);
    i += 1;
    j += 1;
  }
  return out;
}

const diffs = differences(before, after);
const replaced = (before.match(/[Сс]тример[а-я]*/g) ?? []).length - (after.match(/[Сс]тример[а-я]*/g) ?? []).length;

console.log(`${vodId}: знаков ${before.length} → ${after.length}, «5opka» ${(after.match(/5opka/g) ?? []).length}`);
console.log(`заменено вхождений: ${replaced}, расход: ${payload.usage?.cost ?? "?"}`);
if (diffs.length === 0) {
  console.log("сверка пройдена: изменились только эти слова");
  await Bun.write(`/tmp/${vodId}.after.md`, after);
  console.log(`результат отложен в /tmp/${vodId}.after.md`);
} else {
  console.log(`сверка НЕ пройдена, посторонних правок: ${diffs.length}`);
  for (const d of diffs.slice(0, 20)) console.log("  " + d);
}
