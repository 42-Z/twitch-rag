/**
 * Разбор записи: распознать → составить документ → проиндексировать.
 *
 * Оформлено шагами с независимыми повторами, а не одним длинным вызовом:
 * на семичасовой эфир приходится больше сорока кусков, и один вызов не прошёл
 * бы ни по числу внешних обращений, ни по процессорному времени. При сбое
 * переигрывается шаг, а не весь эфир.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, IngestParams, Services } from "./env.ts";
import { createServices } from "./env.ts";
import { shiftSegments, prevailingLanguage, formatDuration } from "../shared/time.ts";
import { vodUrlAt } from "../shared/time.ts";
import { renderTranscript } from "../shared/openrouter.ts";
import { planDocumentParts, assignCategories, uniqueCategories } from "../shared/categories.ts";
import {
  normalizeSections,
  chunkSection,
  buildContextLine,
  type ParsedSection,
} from "../shared/sections.ts";
import { renderDocumentHeader, Documents } from "../shared/documents.ts";
import type { ChunkToIndex } from "../shared/knowledge.ts";

/** Сколько знаков пересказа модель успевает выдать за один проход. */
const CHARS_PER_PART = 60000;
/** Сколько кусков идёт в одно обращение за эмбеддингами. */
const EMBED_BATCH = 32;
/** Разрыв больше этого означает пропущенный участок эфира, а не паузу в речи. */
const MAX_COVERAGE_GAP_SECONDS = 300;

/** Текст распознанного куска: живёт от распознавания до конца разбора. */
const transcriptKey = (vodId: string, index: number): string =>
  `transcript/${vodId}/chunk-${String(index).padStart(4, "0")}.txt`;

/** Склеенная расшифровка всего эфира — то, что видят проходы составления. */
const transcriptFullKey = (vodId: string): string => `transcript/${vodId}/full.txt`;

/** Временное при разборе: удаляется вместе с аудио, каким бы ни был исход. */
const TEMPORARY_PREFIXES = ["audio/", "transcript/"] as const;

export class StreamIngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: Readonly<WorkflowEvent<IngestParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const services = createServices(this.env);

    try {
      await this.process(params, step, services);
    } catch (error) {
      // Куски, ещё не распознанные, остаются в хранилище при любом исходе:
      // уборка отсюда убила бы именно ту переигровку, ради которой шаги и
      // разбиты по кускам. Забытое подчищает почасовая уборка по возрасту
      // (`cleanupStaleAudio` в index.ts).
      const message = error instanceof Error ? error.message : String(error);
      if (!isEngineReset(message) && !(await isAlreadyFinished(params.vodId, services))) {
        // Запись не должна остаться в processing навсегда — её возьмут заново
        // на следующем опросе (schedule.ts проверяет attempts).
        await services.registry.patchStream(params.vodId, { status: "failed", reason: message });
      }
      throw error;
    }
  }

  private async process(params: IngestParams, step: WorkflowStep, services: Services): Promise<void> {
    // --- распознавание ---
    // Шаг на кусок: отказ переигрывает один кусок, а не весь эфир.
    // Удаление куска — отдельный шаг: если распознавание переиграется после
    // сбоя между выполнением и фиксацией шага (например, сброса Durable
    // Object при деплое), кусок в хранилище всё ещё на месте. `R2.delete`
    // отсутствующего ключа не ошибка, так что сам шаг удаления безопасно
    // повторить.
    const languages: string[] = [];
    // Сколько фраз нашлось в каждом куске: по нулю видно, что текста для него
    // в хранилище и не должно быть.
    const phrasesPerChunk: number[] = [];
    let phraseCount = 0;
    let speechSeconds = 0;

    for (const chunk of params.chunks) {
      const result = await step.do(`распознать кусок ${chunk.index}`, async () => {
        const object = await this.env.AUDIO.get(chunk.key);
        if (object === null) throw new Error(`кусок ${chunk.key} исчез из хранилища`);

        const audio = await object.arrayBuffer();
        // Язык не подсказывается: эфир открывается музыкой или тишиной, на
        // которых распознавание ошибается, а навязанный язык портит все
        // следующие куски — русская речь возвращалась английской абракадаброй.
        const transcription = await services.models.transcribe(audio, {
          filename: `chunk-${chunk.index}.m4a`,
        });

        const segments = shiftSegments(transcription.segments, chunk.offsetSeconds);
        // Текст расшифровки уходит в хранилище, а не в результат шага.
        // Результаты шагов лежат в состоянии экземпляра, которое площадка
        // держит три дня после разбора, а расшифровка не должна переживать
        // разбор (FR-010). Возвращается только счёт: он крохотный и без
        // самого текста ничего не выдаёт.
        const text = renderTranscript(segments);
        if (text !== "") {
          await this.env.AUDIO.put(transcriptKey(params.vodId, chunk.index), text, {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          });
        }

        return {
          language: transcription.language,
          phrases: segments.length,
          speechSeconds: Math.round(segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0)),
        };
      });

      await step.do(`удалить кусок ${chunk.index}`, async () => {
        await this.env.AUDIO.delete(chunk.key);
      });

      languages.push(result.language);
      phrasesPerChunk.push(result.phrases);
      phraseCount += result.phrases;
      speechSeconds += result.speechSeconds;
    }

    // Язык эфира — тот, на котором говорят в большинстве кусков, а не тот,
    // что выпал на первом.
    const language = prevailingLanguage(languages);

    if (phraseCount === 0) {
      await step.do("отметить эфир без речи", async () => {
        await services.registry.patchStream(params.vodId, {
          status: "skipped",
          reason: "В записи не распознано ни одной фразы.",
          processedAt: nowUnix(),
        });
        await this.cleanupTemporary(params.vodId);
      });
      return;
    }

    // Куски склеиваются в один текст отдельным шагом: каждому проходу
    // составления нужна расшифровка целиком, а держать её в состоянии
    // экземпляра нельзя. Читаются они по порядку — он же порядок эфира.
    const transcriptChars = await step.do("склеить расшифровку", async () => {
      const parts: string[] = [];
      for (const [position, chunk] of params.chunks.entries()) {
        // В куске без речи текста нет и быть не должно — это не пропажа.
        if (phrasesPerChunk[position] === 0) continue;
        const object = await this.env.AUDIO.get(transcriptKey(params.vodId, chunk.index));
        if (object === null) throw new Error(`расшифровка куска ${chunk.index} исчезла из хранилища`);
        parts.push(await object.text());
      }
      // Куски без речи дают пустую строку: в тексте им делать нечего, иначе
      // на месте музыки и тишины появились бы пустые абзацы, которых в
      // расшифровке целиком не было.
      const text = parts.filter((part) => part !== "").join("\n");
      await this.env.AUDIO.put(transcriptFullKey(params.vodId), text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      return text.length;
    });

    // --- составление документа ---
    // В каждом проходе модель получает расшифровку целиком, но пишет только
    // свой участок: иначе отсылки внутри эфира теряют смысл.
    const partCount = Math.max(1, Math.ceil(transcriptChars / CHARS_PER_PART));
    const parts = planDocumentParts(params.durationSeconds, params.categories, partCount);

    const written: ParsedSection[] = [];
    for (const [index, part] of parts.entries()) {
      const composed = await step.do(`написать часть ${index + 1} из ${parts.length}`, async () => {
        const object = await this.env.AUDIO.get(transcriptFullKey(params.vodId));
        if (object === null) throw new Error("склеенная расшифровка исчезла из хранилища");
        return await services.models.composeDocumentPart({
          fullTranscript: await object.text(),
          part,
          streamTitle: params.title,
          publishedAt: params.publishedAt,
          categories: params.categories,
        });
      });
      written.push(...composed.map((section) => ({ ...section, category: "" })));
    }

    // --- разделы ---
    const sections = await step.do("привести разделы к рабочему виду", async () => {
      const ordered = [...written].sort((a, b) => a.startSeconds - b.startSeconds);
      const withCategories = assignCategories(normalizeSections(ordered), params.categories);
      if (withCategories.length === 0) {
        throw new Error("после приведения не осталось ни одного раздела");
      }
      return withCategories;
    });

    const gaps = findCoverageGaps(sections, params.durationSeconds);
    if (gaps.length > 0) {
      // Разрыв во времени означает пропущенный кусок эфира. Документ всё
      // равно сохраняется — терять разобранное из-за дыры нельзя, — но
      // изъян попадает в реестр, а не остаётся незамеченным.
      console.warn(`разрывы покрытия по ${params.vodId}: ${JSON.stringify(gaps)}`);
    }

    // --- индексация ---
    const chunksToIndex = buildChunks(sections, params, language);

    // Повторный разбор делит эфир на разделы заново, и куски прошлого разбора
    // не обязательно перезаписываются: их номера могут не совпасть. Без этой
    // уборки в выдачу попадала бы смесь двух разборов одной записи.
    await step.do("убрать разделы прошлого разбора", async () => {
      return await services.knowledge.removeStream(params.vodId);
    });

    for (let offset = 0; offset < chunksToIndex.length; offset += EMBED_BATCH) {
      const batch = chunksToIndex.slice(offset, offset + EMBED_BATCH);
      await step.do(`проиндексировать куски ${offset + 1}–${offset + batch.length}`, async () => {
        const vectors = await services.models.embed(batch.map((chunk) => chunk.data));
        await services.knowledge.upsert(
          batch.map((chunk, index) => ({ ...chunk, vector: vectors[index] ?? [] })),
        );
        return batch.length;
      });
    }

    // --- документ и реестр ---
    // Состояние `ready` выставляется последним действием: до этого момента
    // запись не считается разобранной и будет взята заново.
    await step.do("сохранить документ", async () => {
      const header = renderDocumentHeader({
        title: params.title,
        publishedAt: params.publishedAt,
        durationSeconds: params.durationSeconds,
        categories: uniqueCategories(params.categories),
      });
      const body = sections
        .map((section) => `## ${section.title} [${formatRange(section)}]\n\n${section.text}`)
        .join("\n\n");
      await services.documents.save(params.vodId, `${header}\n\n${body}\n`);
    });

    await step.do("отметить запись разобранной", async () => {
      await services.registry.patchStream(params.vodId, {
        status: "ready",
        language,
        sectionCount: sections.length,
        chunkCount: chunksToIndex.length,
        speechSeconds: Math.round(speechSeconds),
        docPath: Documents.path(params.vodId),
        processedAt: nowUnix(),
        // Пометка выставляется всегда, в том числе пустая: иначе на успешно
        // разобранной записи остаётся висеть причина отказа прошлой попытки.
        // В пометке именно длительность: «один участок» может означать и
        // минуту тишины, и четыре часа потерянного эфира.
        reason: gaps.length > 0 ? `Разделы не покрывают ${formatGaps(gaps)} эфира.` : "",
      });
    });

    await step.do("убрать временные файлы разбора", async () => {
      await this.cleanupTemporary(params.vodId);
    });
  }

  /**
   * Уборка по префиксам: при любом исходе после разбора в хранилище не должно
   * остаться ни кусков записи, ни расшифровки — ни целой, ни по частям.
   */
  private async cleanupTemporary(vodId: string): Promise<void> {
    for (const prefix of TEMPORARY_PREFIXES) {
      let cursor: string | undefined;
      do {
        const listed = await this.env.AUDIO.list({
          prefix: `${prefix}${vodId}/`,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (listed.objects.length > 0) {
          await this.env.AUDIO.delete(listed.objects.map((object) => object.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor !== undefined);
    }
  }
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Разбор уже дошёл до итога — отказом его помечать нельзя.
 *
 * Последним шагом идёт уборка временного аудио, и её сбой (или сбой движка
 * после отметки) прежде затирал `ready` на `failed`. Дальше почасовой опрос
 * видел нерастраченные попытки и запускал разбор заново: повторное
 * скачивание, повторное распознавание за деньги и стирание уже готовых
 * векторов. Готовое должно оставаться готовым.
 */
async function isAlreadyFinished(vodId: string, services: Services): Promise<boolean> {
  const record = await services.registry.getStream(vodId).catch(() => undefined);
  return record?.status === "ready" || record?.status === "skipped";
}

/** «2 ч 14 мин в 3 участках» — столько эфира не попало ни в один раздел. */
export function formatGaps(gaps: ReadonlyArray<{ from: number; to: number }>): string {
  const seconds = gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0);
  const duration = formatDuration(seconds);
  return gaps.length === 1 ? duration : `${duration} в ${gaps.length} участках`;
}

/**
 * Сбой самого движка, а не разбора: движок переигрывает `run()` с уже
 * пройденных шагов, и работа продолжается. Помечать такую запись отказом
 * нельзя — наблюдалось на живых прогонах, где после «Durable Object reset»
 * разбор доходил до конца, а в реестре всё это время значился отказ.
 *
 * Разбор вправду умрёт, только когда движок исчерпает свои попытки; тогда
 * последней придёт уже не эта ошибка, и запись будет помечена как надо.
 */
function isEngineReset(message: string): boolean {
  return /Durable Object reset|WorkflowInternalError|internal workflows error/i.test(message);
}

function formatRange(section: ParsedSection): string {
  const clock = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    const h = Math.floor(whole / 3600);
    const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    const s = String(whole % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };
  const range = `${clock(section.startSeconds)} — ${clock(section.endSeconds)}`;
  return section.category === "" ? range : `${range} · ${section.category}`;
}

/** Участки эфира, не покрытые ни одним разделом (FR-019). */
export function findCoverageGaps(
  sections: readonly ParsedSection[],
  durationSeconds: number,
): Array<{ from: number; to: number }> {
  const ordered = [...sections].sort((a, b) => a.startSeconds - b.startSeconds);
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = 0;

  for (const section of ordered) {
    if (section.startSeconds - cursor > MAX_COVERAGE_GAP_SECONDS) {
      gaps.push({ from: cursor, to: section.startSeconds });
    }
    cursor = Math.max(cursor, section.endSeconds);
  }
  if (durationSeconds - cursor > MAX_COVERAGE_GAP_SECONDS) {
    gaps.push({ from: cursor, to: durationSeconds });
  }
  return gaps;
}

/** Разделы превращаются в куски с контекстной строкой и метаданными для выдачи. */
export function buildChunks(
  sections: readonly ParsedSection[],
  params: IngestParams,
  language: string,
): Array<Omit<ChunkToIndex, "vector">> {
  const result: Array<Omit<ChunkToIndex, "vector">> = [];

  sections.forEach((section, sectionIndex) => {
    const contextLine = buildContextLine({
      publishedAt: params.publishedAt,
      category: section.category,
      sectionTitle: section.title,
    });

    for (const chunk of chunkSection(section, contextLine)) {
      result.push({
        vodId: params.vodId,
        sectionIndex,
        chunkIndex: chunk.chunkIndex,
        data: chunk.text,
        metadata: {
          vodId: params.vodId,
          title: params.title,
          publishedAt: params.publishedAt,
          publishedAtUnix: Math.floor(new Date(params.publishedAt).getTime() / 1000),
          category: section.category,
          sectionIndex,
          sectionTitle: section.title,
          sectionText: section.text,
          startSeconds: section.startSeconds,
          endSeconds: section.endSeconds,
          url: vodUrlAt(params.vodId, section.startSeconds),
          language,
        },
      });
    }
  });

  return result;
}
