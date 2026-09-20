/**
 * Разделы документа → куски векторного индекса.
 *
 * Живёт вне Worker, потому что «что именно уходит в метаданные куска» — часть
 * контракта выдачи: имя документа, время раздела, категория и ссылка на
 * момент записи читаются оттуда, и проверяются они без изолята.
 */

import { vodUrlAt } from "./time.ts";
import { buildContextLine, chunkSection, type ParsedSection } from "./sections.ts";
import type { ChunkToIndex } from "./knowledge.ts";

export interface ChunkSource {
  /** Запись реестра: ключ кусков в векторной базе. */
  streamId: string;
  /** Номер записи на площадке: по нему строится ссылка на момент эфира. */
  vodId: string;
  publishedAt: string;
}

export interface BuildChunksInput {
  sections: readonly ParsedSection[];
  stream: ChunkSource;
  language: string;
  /**
   * Имя документа, выработанное по содержанию эфира. В метаданных оно стоит
   * в поле `title`: заголовок с площадки в выдаче не появляется (FR-025,
   * FR-027).
   */
  docTitle: string;
}

export function buildChunks(input: BuildChunksInput): Array<Omit<ChunkToIndex, "vector">> {
  const result: Array<Omit<ChunkToIndex, "vector">> = [];

  input.sections.forEach((section, sectionIndex) => {
    const contextLine = buildContextLine({
      publishedAt: input.stream.publishedAt,
      category: section.category,
      sectionTitle: section.title,
    });

    for (const chunk of chunkSection(section, contextLine)) {
      result.push({
        streamId: input.stream.streamId,
        sectionIndex,
        chunkIndex: chunk.chunkIndex,
        data: chunk.text,
        metadata: {
          streamId: input.stream.streamId,
          vodId: input.stream.vodId,
          title: input.docTitle,
          publishedAt: input.stream.publishedAt,
          publishedAtUnix: Math.floor(new Date(input.stream.publishedAt).getTime() / 1000),
          category: section.category,
          sectionIndex,
          sectionTitle: section.title,
          sectionText: section.text,
          startSeconds: section.startSeconds,
          endSeconds: section.endSeconds,
          url: vodUrlAt(input.stream.vodId, section.startSeconds),
          language: input.language,
        },
      });
    }
  });

  return result;
}
