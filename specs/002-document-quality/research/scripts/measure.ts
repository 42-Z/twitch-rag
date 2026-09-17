/**
 * Проверка 2: сколько выходит документ по настоящей расшифровке и удерживается
 * ли запрет на потери.
 *
 * Один и тот же участок расшифровки подаётся модели по трём инструкциям:
 *
 *   A — сегодняшняя, из `src/shared/openrouter.ts`, слово в слово;
 *   B — предлагаемая спецификацией: назначение работы — понятный текст из
 *       хаоса, сказанное не теряется, убирается только шум;
 *   C — то же, что B, плюс привязка объёма к участку.
 *
 * Инструкция C проверяет догадку: одного требования «не сокращай» мало —
 * прошлый замер на письменном тексте дал сжатие вдвое. Если и с привязкой
 * объёма текст выходит вдвое короче сказанного, значит без потерь одним
 * промптом не берётся и нужна проверка на выходе.
 *
 * Запуск:
 *   bun specs/002-document-quality/research/scripts/measure.ts --transcript 2875806701-1200-5400
 */

import path from "node:path";
import { DOCUMENT_SYSTEM_PROMPT, buildDocumentPrompt } from "../../../../src/shared/openrouter.ts";

const API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "inclusionai/ling-3.0-flash";
const MAX_OUTPUT_TOKENS = 32768;
const TEMPERATURE = 0.3;
/** Цены Novita на 2026-09-17, доллары за токен. */
const PRICE = { prompt: 0.000000021, completion: 0.000000063 };

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

const researchDir = path.resolve(import.meta.dir, "..");
const dataDir = path.join(researchDir, "data");
const label: string = arg("transcript");
const limit = Number(arg("chars", "60000"));
/** Длина участка прохода в минутах; ноль — весь замеряемый отрезок. */
const partMinutes = Number(arg("part-minutes", "0"));
const runLabel = partMinutes === 0 ? label : `${label}-part${partMinutes}`;

interface TranscriptReport {
  vod: string;
  title: string;
  publishedAt: string;
  section: { from: number; to: number; seconds: number };
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number }>;
}

const report = (await Bun.file(path.join(dataDir, `transcript-${label}.json`)).json()) as TranscriptReport;
const full = await Bun.file(path.join(dataDir, `transcript-${label}.txt`)).text();

/** Участок режется по границе фразы: обрывок строки исказил бы замер. */
function slice(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.lastIndexOf("\n", chars);
  return text.slice(0, cut === -1 ? chars : cut);
}

const transcript = slice(full, limit);
console.log(`расшифровка: ${transcript.length} знаков из ${full.length}`);

// Участок, который модель пишет в этот проход. Остальная расшифровка остаётся
// перед глазами как контекст — так же, как в разборе.
const partEnd = partMinutes === 0 ? report.section.to : Math.min(report.section.from + partMinutes * 60, report.section.to);
const partLines = transcript.split("\n").filter((line) => {
  const match = line.match(/^\[(\d+)\]/);
  return match === null || Number(match[1]) <= partEnd;
});
const partChars = partLines.join("\n").length;
console.log(`участок прохода: ${report.section.from}–${partEnd} с, ${partChars} знаков расшифровки`);

const categories = report.chapters.map((chapter) => `- ${chapter.title}: ${chapter.startSeconds}–${chapter.endSeconds} с`).join("\n");

/**
 * Предлагаемая инструкция. Это не решение, а материал для замера: текст
 * собран по требованиям FR-001–FR-013 спецификации 002.
 */
const CANDIDATE_SYSTEM_PROMPT = `Ты превращаешь расшифровку трансляции в понятный и осмысленный документ о том, что на ней было.

Ответ — только JSON такого вида, без markdown и пояснений вокруг:
{"sections": [{"title": "Спор о правилах сервера", "startSeconds": 4040, "endSeconds": 4745, "text": "Текст раздела в несколько абзацев."}]}

Назначение работы:
1. Расшифровка — это хаос: слова слиты, имена и термины перевраны, на музыке и шуме распознавание выдаёт бессмыслицу. Твоя задача — привести её в понятный вид, а не сократить.
2. Сказанное не теряется. Всё, что прозвучало и несёт сведения, остаётся в тексте: темы, доводы, возражения, примеры, подробности, оговорки, обещания, сроки, обстоятельства, итоги. Приветствия, объявления о перерыве, рекламные вставки и обращения к чату — тоже часть эфира.
3. Сжимать можно только за счёт плотности изложения: те же сведения меньшим числом слов. Отбрасывать сведения нельзя.
4. Убирается только шум: музыка, тишина, заглушённые участки, слова-заикания, повторы-заминки, брошенные фразы, бессмыслица и куски на чужом языке от сбоев распознавания.
5. Ошибки распознавания в именах, терминах, числах и границах слов исправляй по общему смыслу эфира: как это звучало в других местах, что происходит по ходу разговора. Восстанавливай сказанное, а не придумывай несказанное.
6. Никаких отсылок вместо сути: не «объясняет, почему…», а само объяснение; не «обсуждают планы», а какие именно планы и к чему пришли.
7. Конкретика сохраняется: имена, прозвища, названия, числа, суммы, сроки, названия игр и сервисов — так, как прозвучали.
8. Если тему только назвали и не раскрыли, пиши то немногое, что прозвучало. Дописывать нечего.
9. Раздел понятен сам по себе: называй участников, предметы и обстоятельства, а не «он», «это», «там же».
10. Пиши по-русски — и названия разделов, и текст, — независимо от языка расшифровки.
11. Разделы идут подряд по времени и покрывают весь участок целиком, без пропусков.
12. В поле text — только содержание раздела, без вступлений и обращений к читателю.`;

const VOLUME_RULE = `
13. Объём текста по участку — не меньше 80% знаков расшифровки этого участка. Текст вдвое короче сказанного означает потерянное содержание: подробности, доводы и оговорки, без которых раздел отвечает не на тот вопрос, который задаст читатель.`;

/** Тот же запрос, что строит разбор, но без заголовка эфира: он в разборе больше не участвует. */
function candidateUserPrompt(): string {
  return `Дата эфира: ${report.publishedAt.slice(0, 10)}

Категории эфира по времени:
${categories === "" ? "- категории не указаны" : categories}

Твой участок: с ${report.section.from} по ${partEnd} секунду записи.
Пиши разделы только про этот участок. Остальная расшифровка дана, чтобы ты понимал отсылки и не пересказывал одно и то же дважды.

Расшифровка эфира целиком (время в секундах от начала записи):

${transcript}`;
}

interface Variant {
  name: string;
  system: string;
  user: string;
}

const variants: Variant[] = [
  {
    name: "A-сегодня",
    system: DOCUMENT_SYSTEM_PROMPT,
    user: buildDocumentPrompt({
      fullTranscript: transcript,
      part: { startSeconds: report.section.from, endSeconds: partEnd },
      streamTitle: report.title,
      publishedAt: report.publishedAt,
      categories: report.chapters,
    }),
  },
  { name: "B-без-потерь", system: CANDIDATE_SYSTEM_PROMPT, user: candidateUserPrompt() },
  { name: "C-с-объёмом", system: `${CANDIDATE_SYSTEM_PROMPT}\n${VOLUME_RULE}`, user: candidateUserPrompt() },
];

async function chat(system: string, user: string, maxTokens: number, json = true): Promise<any> {
  const response = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: TEMPERATURE,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`модель ответила ${response.status}: ${await response.text()}`);
  return await response.json();
}

// Сколько токенов занимает сама расшифровка: от этого зависит, поместится ли
// эфир целиком в контекст модели.
const probe = await chat("Отвечай одним словом.", transcript, 1, false);
const transcriptTokens: number = probe.usage?.prompt_tokens ?? 0;
console.log(`расшифровка участка: ${transcriptTokens} токенов (${(transcript.length / transcriptTokens).toFixed(2)} знака на токен)`);

/** Отбор инструкций и повторов: одна длина участка меряется несколько раз. */
const wanted = arg("variants", "").split(",").filter((value) => value !== "");
const chosen = wanted.length === 0 ? variants : variants.filter((variant) => wanted.some((prefix) => variant.name.startsWith(prefix)));
if (chosen.length === 0) throw new Error(`ни одна инструкция не подходит под «${wanted.join(",")}»`);
const repeat = Number(arg("repeat", "1"));

const results: unknown[] = [];
for (let round = 1; round <= repeat; round++) {
for (const variant of chosen) {
  const roundLabel = repeat === 1 ? "" : `-r${round}`;
  console.log(`\n${variant.name}${roundLabel}: запрос…`);
  const started = Date.now();
  const response = await chat(variant.system, variant.user, MAX_OUTPUT_TOKENS);
  const elapsed = Date.now() - started;

  const choice = response.choices?.[0] ?? {};
  const text: string = choice.message?.content ?? "";
  const usage = response.usage ?? {};
  let sections: Array<{ title: string; text: string; startSeconds: number; endSeconds: number }> = [];
  try {
    sections = (JSON.parse(text) as { sections?: typeof sections }).sections ?? [];
  } catch {
    sections = [];
  }
  const sectionChars = sections.reduce((sum, section) => sum + (section.text ?? "").length, 0);

  const record = {
    variant: variant.name,
    round,
    partMinutes,
    partChars,
    model: response.model ?? MODEL,
    provider: response.provider ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    /** Расход целиком: у модели бывают скрытые рассуждения, и они съедают потолок выхода. */
    usage: usage,
    costUsd: usage.cost ?? null,
    costByPrice:
      usage.prompt_tokens === undefined
        ? null
        : usage.prompt_tokens * PRICE.prompt + (usage.completion_tokens ?? 0) * PRICE.completion,
    finishReason: choice.finish_reason ?? null,
    milliseconds: elapsed,
    outputChars: text.length,
    sections: sections.length,
    sectionChars,
    /** Доля от всей расшифровки и от участка прохода: второе важнее — по нему видно, сколько теряется внутри участка. */
    compression: Number((sectionChars / transcript.length).toFixed(3)),
    partCompression: Number((sectionChars / partChars).toFixed(3)),
    parsed: sections.length > 0,
  };
  results.push(record);
  await Bun.write(path.join(dataDir, `document-${runLabel}-${variant.name}${roundLabel}.json`), `${JSON.stringify({ record, sections }, null, 2)}\n`);
  // Сырой ответ — на случай, если понадобится разобрать его иначе, чем здесь.
  await Bun.write(path.join(dataDir, `raw-${runLabel}-${variant.name}${roundLabel}.json`), `${JSON.stringify(response, null, 2)}\n`);

  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  console.log(
    `  ${variant.name}${roundLabel}: выход ${record.completionTokens} токенов (из них рассуждений ${reasoning}), ` +
      `${record.sectionChars} знаков в ${record.sections} разделах, ${Math.round(record.partCompression * 100)}% ` +
      `от участка прохода, остановка ${record.finishReason}, провайдер ${record.provider}, ${(elapsed / 1000).toFixed(0)} с`,
  );
}
}

const summary = {
  label,
  model: MODEL,
  partMinutes,
  partChars,
  measuredAt: new Date().toISOString(),
  transcript: {
    vod: report.vod,
    title: report.title,
    chars: transcript.length,
    tokens: transcriptTokens,
    charsPerToken: Number((transcript.length / transcriptTokens).toFixed(3)),
    sectionSeconds: report.section.seconds,
  },
  limits: { maxOutputTokens: MAX_OUTPUT_TOKENS, contextTokens: 262144, provider: "Novita", altProviderContext: 131072 },
  results,
};
await Bun.write(path.join(dataDir, `measure-${runLabel}.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nсохранено: data/measure-${runLabel}.json`);
