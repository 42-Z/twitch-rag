/**
 * Векторная база: куски разделов внутри, разделы целиком наружу.
 *
 * В индексе лежат куски (полторы–три тысячи знаков), а клиенту уходит раздел
 * целиком — его текст продублирован в метаданных каждого куска. Это
 * сознательный размен: выдача не требует второго обращения к хранилищу.
 */

import { Index } from "@upstash/vector";
import { AppError, upstreamError } from "./errors.ts";

export interface KnowledgeConfig {
  url: string;
  token: string;
}

export interface ChunkMetadata {
  vodId: string;
  /** Имя документа, выработанное по содержанию эфира (FR-025, FR-027). */
  title: string;
  publishedAt: string;
  publishedAtUnix: number;
  category: string;
  sectionIndex: number;
  sectionTitle: string;
  /** Текст раздела целиком — именно он уходит в ответ. */
  sectionText: string;
  startSeconds: number;
  endSeconds: number;
  url: string;
  language: string;
}

export interface ChunkToIndex {
  vodId: string;
  sectionIndex: number;
  chunkIndex: number;
  /** Текст куска вместе с контекстной строкой — как он ушёл в эмбеддинг. */
  data: string;
  vector: number[];
  metadata: ChunkMetadata;
}

export interface SearchOptions {
  topK: number;
  minScore: number;
  fromUnix?: number;
  toUnix?: number;
  category?: string;
}

export interface FoundSection {
  id: string;
  topic: string;
  text: string;
  score: number;
  category: string;
  stream: { vodId: string; title: string; publishedAt: string; url: string };
  startSeconds: number;
  endSeconds: number;
}

/** `<vodId>:<sectionIndex>:<chunkIndex>` — префикс позволяет снести трансляцию одной операцией. */
export function chunkId(vodId: string, sectionIndex: number, chunkIndex: number): string {
  return `${vodId}:${sectionIndex}:${chunkIndex}`;
}

export class Knowledge {
  private readonly index: Index<Record<string, unknown>>;

  constructor(config: KnowledgeConfig) {
    this.index = new Index({ url: config.url, token: config.token });
  }

  async upsert(chunks: readonly ChunkToIndex[]): Promise<void> {
    if (chunks.length === 0) return;
    try {
      await this.index.upsert(
        chunks.map((chunk) => ({
          id: chunkId(chunk.vodId, chunk.sectionIndex, chunk.chunkIndex),
          vector: chunk.vector,
          data: chunk.data,
          metadata: { ...chunk.metadata },
        })),
      );
    } catch (error) {
      throw upstreamError("векторная база", error);
    }
  }

  /**
   * Поиск возвращает разделы, а не куски: два куска одного раздела
   * схлопываются в один результат с лучшей оценкой.
   *
   * Кусков просится больше, чем нужно разделов, — иначе схлопывание съело бы
   * часть выдачи и клиент получил бы меньше `topK`.
   */
  async search(vector: number[], options: SearchOptions): Promise<FoundSection[]> {
    const filter = buildFilter(options);
    let raw;
    try {
      raw = await this.index.query({
        vector,
        topK: Math.min(options.topK * 4, 100),
        includeMetadata: true,
        ...(filter === "" ? {} : { filter }),
      });
    } catch (error) {
      throw upstreamError("векторная база", error);
    }

    const bySection = new Map<string, FoundSection>();
    for (const match of raw) {
      if (match.score < options.minScore) continue;
      const metadata = match.metadata as unknown as ChunkMetadata | undefined;
      if (metadata === undefined) continue;

      const key = `${metadata.vodId}:${metadata.sectionIndex}`;
      const existing = bySection.get(key);
      if (existing !== undefined && existing.score >= match.score) continue;

      bySection.set(key, {
        id: key,
        topic: metadata.sectionTitle,
        text: metadata.sectionText,
        score: match.score,
        category: metadata.category,
        stream: {
          vodId: metadata.vodId,
          title: metadata.title,
          publishedAt: metadata.publishedAt,
          url: metadata.url,
        },
        startSeconds: metadata.startSeconds,
        endSeconds: metadata.endSeconds,
      });
    }

    return [...bySection.values()].sort((a, b) => b.score - a.score).slice(0, options.topK);
  }

  /** Удаление всех кусков трансляции по префиксу идентификатора. */
  async removeStream(vodId: string): Promise<number> {
    try {
      const result = await this.index.delete({ prefix: `${vodId}:` });
      return result.deleted;
    } catch (error) {
      throw upstreamError("векторная база", error);
    }
  }

  /**
   * Уборка кусков прошлого разбора: удаляется всё, чего нет среди новых.
   *
   * Повторный разбор делит эфир на разделы заново, и номера кусков не
   * совпадают. Снести прежние перед записью новых нельзя: неудачный повтор
   * оставил бы трансляцию без знаний вовсе (FR-032). Поэтому новые куски
   * пишутся первыми, а прежние вычищаются следом — по перечислению, потому
   * что метаданные кусков прошлых разборов не несут ни признака прогона, ни
   * чего-либо ещё, по чему их можно отличить фильтром.
   */
  async removeExcept(vodId: string, keep: ReadonlySet<string>): Promise<number> {
    const stale: string[] = [];
    // Курсор — строка, и первый запрос идёт с "0": так это описано в
    // справочнике по точке `range`. Пустая строка в ответе означает, что
    // страниц больше нет, — по ней и заканчивается обход.
    let cursor = "0";
    try {
      do {
        // Тип страницы выписан явно: курсор и страница ссылаются друг на
        // друга, и вывод типов на этом зацикливается.
        const page: { nextCursor: string; vectors: Array<{ id: string }> } = await this.index.range({
          cursor,
          limit: 100,
          prefix: `${vodId}:`,
        });
        for (const vector of page.vectors) {
          if (!keep.has(vector.id)) stale.push(vector.id);
        }
        cursor = page.nextCursor;
      } while (cursor !== "");
      // Удаление — после обхода целиком: удалять по ходу значило бы сдвигать
      // страницы под собой и пропускать куски.
      if (stale.length > 0) await this.index.delete(stale);
    } catch (error) {
      throw upstreamError("векторная база", error);
    }
    return stale.length;
  }

  async stats(): Promise<{ vectorCount: number }> {
    try {
      const info = await this.index.info();
      return { vectorCount: info.vectorCount };
    } catch (error) {
      throw upstreamError("векторная база", error);
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.index.info();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Язык фильтров Upstash Vector. Строки берутся в кавычки, а способа
 * заэкранировать кавычку внутри строки документация не описывает (проверено
 * по разделу о фильтрах): поэтому значение с кавычкой, обратным слэшем или
 * переводом строки отвергается, а не подставляется как есть. Иначе фильтр
 * превращался бы в синтаксическую ошибку на стороне сервиса вместо понятного
 * отказа, а при неудачном стечении — в подстановку чужого условия.
 */
const UNSAFE_IN_FILTER = /['"\\\u0000-\u001f]/;

export function buildFilter(options: SearchOptions): string {
  const parts: string[] = [];
  if (options.fromUnix !== undefined) parts.push(`publishedAtUnix >= ${Math.floor(options.fromUnix)}`);
  if (options.toUnix !== undefined) parts.push(`publishedAtUnix <= ${Math.floor(options.toUnix)}`);
  if (options.category !== undefined && options.category !== "") {
    if (UNSAFE_IN_FILTER.test(options.category)) {
      throw new AppError("invalid_input", "В названии категории не должно быть кавычек и обратных слэшей.");
    }
    parts.push(`category = '${options.category}'`);
  }
  return parts.join(" AND ");
}
