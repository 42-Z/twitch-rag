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
   * `multipart` включён не ради размера: обычная запись подписывает заголовок
   * `content-length`, но Workers при теле-потоке шлёт запрос chunked-кодировкой
   * и этот заголовок до R2 не доносит — подпись не сходится, приходит 403
   * `signature_mismatch`. Многочастный путь SDK отправляет часть готовым
   * массивом байтов, и длина доходит неизменной. Проверено в workerd:
   * обычная запись падает, многочастная проходит и читается обратно дословно.
   */
  async save(vodId: string, markdown: string): Promise<void> {
    try {
      await this.bucket.put(Documents.path(vodId), markdown, {
        contentType: "text/markdown; charset=utf-8",
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

/** Шапка документа: то, что человек видит до первого раздела. */
export function renderDocumentHeader(input: {
  title: string;
  publishedAt: string;
  durationSeconds: number;
  categories: readonly string[];
}): string {
  const date = input.publishedAt.slice(0, 10);
  const duration = formatDuration(input.durationSeconds);
  const categories = input.categories.length > 0 ? `\n\n**Категории**: ${input.categories.join(", ")}` : "";
  return `# ${input.title}\n\n**Эфир**: ${date} · **Длительность**: ${duration}${categories}`;
}
