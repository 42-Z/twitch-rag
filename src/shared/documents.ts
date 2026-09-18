/**
 * Документы трансляций в Upstash Blob.
 *
 * Это витрина для человека и источник для повторной индексации. Бакет
 * приватный, поэтому страница получает содержимое через Worker, а не по
 * прямой ссылке.
 */

import { Bucket } from "@upstash/blob";
import { AppError, upstreamError } from "./errors.ts";
import { formatDuration } from "./time.ts";

export interface DocumentsConfig {
  token: string;
}

export class Documents {
  private readonly bucket: Bucket;

  constructor(config: DocumentsConfig) {
    this.bucket = new Bucket({ token: config.token });
  }

  static path(vodId: string): string {
    return `streams/${vodId}.md`;
  }

  /**
   * Документ пишется один раз и целиком — после того, как составлены все его
   * части. Половины документа в хранилище не бывает.
   *
   * `multipart` включён не ради размера. Проверено в workerd: обычная запись
   * падает с 403 `signature_mismatch`, многочастная проходит и читается
   * обратно дословно. Почему падает — неизвестно: справочник называет причиной
   * такого отказа расхождение подписанной длины или типа тела с отправленными,
   * но про запись из Workers не говорит ничего, и их справочная служба ответа
   * не даёт. Догадка про chunked-кодировку, которая съедает `content-length`,
   * подтверждения не нашла.
   *
   * `cache` задан явно, хотя по умолчанию кэш и так недолгий. Адрес документа
   * постоянный, а содержимое переписывается при повторном разборе, — это ровно
   * тот случай, о котором документация предупреждает: «`url` не меняется, и
   * кэши продолжают отдавать старые байты». По умолчанию объект ложится с
   * `public, max-age=3600`, и повторный разбор до часа оставался бы невидимым.
   * `no-store` документация называет выбором для приватного содержимого.
   */
  async save(vodId: string, markdown: string): Promise<void> {
    try {
      await this.bucket.put(Documents.path(vodId), markdown, {
        contentType: "text/markdown; charset=utf-8",
        cache: "no-store",
        multipart: true,
      });
    } catch (error) {
      throw upstreamError("хранилище документов", error);
    }
  }

  async read(vodId: string): Promise<string> {
    let download: { body: ReadableStream<Uint8Array> };
    try {
      download = await this.bucket.get(Documents.path(vodId));
    } catch (error) {
      throw new AppError("not_found", "Документ этой трансляции не найден.", { cause: error });
    }
    return await new Response(download.body).text();
  }

  async exists(vodId: string): Promise<boolean> {
    try {
      return await this.bucket.exists(Documents.path(vodId));
    } catch (error) {
      throw upstreamError("хранилище документов", error);
    }
  }

  async remove(vodId: string): Promise<void> {
    try {
      await this.bucket.del(Documents.path(vodId));
    } catch (error) {
      throw upstreamError("хранилище документов", error);
    }
  }

  /**
   * Проверка доступности для `/api/health`: ошибка не поднимается,
   * возвращается признак.
   *
   * Проверяется именно запись, а не чтение: разбор записи упирается в `put`,
   * и проверка чтением однажды уже отрапортовала «ок» на хранилище, в которое
   * невозможно было записать.
   */
  async healthy(): Promise<boolean> {
    const probe = "streams/.health";
    try {
      await this.bucket.put(probe, "ok", { contentType: "text/plain; charset=utf-8", multipart: true });
      await this.bucket.del(probe);
      return true;
    } catch (error) {
      console.error(`[хранилище документов] проверка записи: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/**
 * Шапка документа: то, что человек видит до первого раздела.
 *
 * Заголовок здесь — имя документа, выработанное по содержанию эфира, а не
 * заголовок трансляции с площадки: тому в документе места нет (FR-027).
 */
export function renderDocumentHeader(input: {
  name: string;
  publishedAt: string;
  durationSeconds: number;
  categories: readonly string[];
}): string {
  const date = input.publishedAt.slice(0, 10);
  const duration = formatDuration(input.durationSeconds);
  const categories = input.categories.length > 0 ? `\n\n**Категории**: ${input.categories.join(", ")}` : "";
  return `# ${input.name}\n\n**Эфир**: ${date} · **Длительность**: ${duration}${categories}`;
}
