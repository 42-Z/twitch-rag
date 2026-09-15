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
import { mergeTranscripts, shiftSegments, type TranscriptSegment } from "../shared/time.ts";
import { vodUrlAt } from "../shared/time.ts";
import { renderTranscript } from "../shared/openrouter.ts";
import { planDocumentParts, assignCategories, uniqueCategories } from "../shared/categories.ts";
import {
  parseDocument,
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

export class StreamIngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: Readonly<WorkflowEvent<IngestParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const services = createServices(this.env);

    try {
      await this.process(params, step, services);
    } catch (error) {
      // Шаги переигрываются сами; сюда попадает только исчерпанная попытка.
      // Запись не должна остаться в processing навсегда — её нужно взять
      // заново на следующем опросе (schedule.ts проверяет attempts).
      const message = error instanceof Error ? error.message : String(error);
      await services.registry.patchStream(params.vodId, { status: "failed", reason: message });
      await this.cleanupAudio(params.vodId).catch(() => undefined);
      throw error;
    }
  }

  private async process(params: IngestParams, step: WorkflowStep, services: Services): Promise<void> {
    // --- распознавание ---
    // Шаг на кусок: отказ переигрывает один кусок, а не весь эфир.
    // Кусок удаляется из хранилища сразу после успеха — аудио живёт минуты.
    const perChunk: TranscriptSegment[][] = [];
    let language = "";

    for (const chunk of params.chunks) {
      const result = await step.do(`распознать кусок ${chunk.index}`, async () => {
        const object = await this.env.AUDIO.get(chunk.key);
        if (object === null) throw new Error(`кусок ${chunk.key} исчез из хранилища`);

        const audio = await object.arrayBuffer();
        const transcription = await services.models.transcribe(audio, {
          filename: `chunk-${chunk.index}.m4a`,
          ...(language === "" ? {} : { language }),
        });

        await this.env.AUDIO.delete(chunk.key);
        return {
          language: transcription.language,
          segments: shiftSegments(transcription.segments, chunk.offsetSeconds),
        };
      });

      if (language === "") language = result.language;
      perChunk.push(result.segments);
    }

    const transcript = mergeTranscripts(perChunk);
    if (transcript.length === 0) {
      await step.do("отметить эфир без речи", async () => {
        await services.registry.patchStream(params.vodId, {
          status: "skipped",
          reason: "В записи не распознано ни одной фразы.",
          processedAt: nowUnix(),
        });
        await this.cleanupAudio(params.vodId);
      });
      return;
    }

    const transcriptText = renderTranscript(transcript);
    const speechSeconds = transcript.reduce((sum, segment) => sum + (segment.end - segment.start), 0);

    // --- составление документа ---
    // В каждом проходе модель получает расшифровку целиком, но пишет только
    // свой участок: иначе отсылки внутри эфира теряют смысл.
    const partCount = Math.max(1, Math.ceil(transcriptText.length / CHARS_PER_PART));
    const parts = planDocumentParts(params.durationSeconds, params.categories, partCount);

    const written: string[] = [];
    for (const [index, part] of parts.entries()) {
      const text = await step.do(`написать часть ${index + 1} из ${parts.length}`, async () =>
        await services.models.composeDocumentPart({
          fullTranscript: transcriptText,
          part,
          streamTitle: params.title,
          publishedAt: params.publishedAt,
          categories: params.categories,
        }),
      );
      written.push(text);
    }

    // --- разделы ---
    const sections = await step.do("разобрать документ на разделы", async () => {
      const parsed = parseDocument(written.join("\n\n"));
      const normalized = normalizeSections(parsed);
      const withCategories = assignCategories(normalized, params.categories);
      if (withCategories.length === 0) {
        throw new Error("модель не дала ни одного раздела с заголовком");
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
        ...(gaps.length > 0
          ? { reason: `Разделы не покрывают ${gaps.length} участк(ов) эфира.` }
          : {}),
      });
    });

    await step.do("убрать временное аудио", async () => {
      await this.cleanupAudio(params.vodId);
    });
  }

  /**
   * Уборка по префиксу: при любом исходе после разбора в хранилище не должно
   * остаться ни одного куска этой записи.
   */
  private async cleanupAudio(vodId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listed = await this.env.AUDIO.list({
        prefix: `audio/${vodId}/`,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (listed.objects.length > 0) {
        await this.env.AUDIO.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
  }
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
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
