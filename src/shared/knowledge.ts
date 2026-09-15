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
 * Язык фильтров Upstash Vector. Строки берутся в одинарные кавычки, поэтому
 * кавычка внутри категории должна быть обезврежена — иначе фильтр
 * превращается в синтаксическую ошибку на стороне сервиса.
 */
export function buildFilter(options: SearchOptions): string {
  const parts: string[] = [];
  if (options.fromUnix !== undefined) parts.push(`publishedAtUnix >= ${Math.floor(options.fromUnix)}`);
  if (options.toUnix !== undefined) parts.push(`publishedAtUnix <= ${Math.floor(options.toUnix)}`);
  if (options.category !== undefined && options.category !== "") {
    if (options.category.includes("'")) {
      throw new AppError("invalid_input", "В названии категории не должно быть апострофа.");
    }
    parts.push(`category = '${options.category}'`);
  }
  return parts.join(" AND ");
}
