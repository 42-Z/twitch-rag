/**
 * Выгрузка кусков в R2 и сигнал Worker: можно начинать.
 *
 * Бокс работает снаружи Cloudflare, поэтому привязкой к бакету
 * воспользоваться не может — запросы подписываются ключами S3. Подпись берёт
 * `aws4fetch`: боксу нужна только она, а не мегабайтный SDK.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import type { AudioChunk } from "./segment.ts";
import type { Chapter } from "./media.ts";
import type { Frame } from "../shared/frames.ts";

/**
 * Срок ссылки на кадр. Самый длинный разбор идёт заметно меньше часа, шесть
 * часов покрывают повторы шагов с большим запасом, а мёртвая ссылка не опасна:
 * объекты за ней убираются в конце разбора. Подписанный адрес R2 —
 * носитель доступа до истечения подписи, поэтому срок не больше нужного
 * ([R2: Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/):
 * от 1 секунды до 7 суток; `research.md` §2).
 */
export const FRAME_URL_TTL_SECONDS = 21600;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface IngestPayload {
  /** Запись реестра: `<vodId>` или `<vodId>-p<номер части>`. */
  streamId: string;
  /** Номер записи на площадке. */
  vodId: string;
  /** Начало отрезка от начала эфира. */
  partStartSeconds: number;
  /**
   * Идентификатор этого прогона. По нему Worker называет инстанс разбора:
   * повторный сигнал того же прогона (бокс шлёт его снова после обрыва сети)
   * попадает в занятое имя и второго разбора не создаёт, а новый прогон той
   * же записи получает собственное имя и не упирается в прошлый — имя
   * инстанса занято навсегда, метода удаления в API Workers нет.
   */
  runId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  categories: Chapter[];
  chunks: Array<{ index: number; key: string; offsetSeconds: number; durationSeconds: number }>;
  /**
   * Кадры эфира по возрастанию `atSeconds`, только удавшиеся. Пустой список
   * равен отсутствию кадров: прежняя программа поля не шлёт, и разбор идёт по речи.
   */
  frames?: Frame[];
}

export function audioKey(streamId: string, index: number): string {
  return `audio/${streamId}/chunk-${String(index).padStart(4, "0")}.m4a`;
}

/**
 * Ключ определяется моментом кадра: повторный прогон той же записи
 * перезаписывает те же объекты, а не плодит копии. Префикс `frames/` входит в
 * перечень временного на стороне Worker (`worker/temporary.ts`) — по нему
 * кадры убираются после разбора.
 */
export function frameKey(streamId: string, atSeconds: number): string {
  return `frames/${streamId}/frame-${String(atSeconds).padStart(6, "0")}.jpg`;
}

/** Повтор сорвавшегося действия: звук и кадры ходят в R2 по одним правилам. */
export async function withRetries<T>(action: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class Publisher {
  private readonly client: AwsClient;
  private readonly endpoint: string;

  private readonly config: R2Config;

  constructor(config: R2Config) {
    this.config = config;
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;
  }

  async uploadChunks(streamId: string, workDir: string, chunks: readonly AudioChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const body = await readFile(path.join(workDir, chunk.file));
      await withRetries(async () => {
        const response = await this.client.fetch(`${this.endpoint}/${audioKey(streamId, chunk.index)}`, {
          method: "PUT",
          body,
          headers: { "content-type": "audio/mp4" },
        });
        if (!response.ok) {
          throw new Error(`R2 отклонил кусок ${chunk.index}: ${response.status}`);
        }
      });
    }
  }

  /** Кадр в R2; возвращает ключ. До четырёх попыток, как у звука. */
  async uploadFrame(streamId: string, atSeconds: number, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const key = frameKey(streamId, atSeconds);
    await withRetries(async () => {
      const response = await this.client.fetch(`${this.endpoint}/${key}`, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "image/jpeg" },
      });
      if (!response.ok) {
        throw new Error(`R2 отклонил кадр ${atSeconds}: ${response.status}`);
      }
    });
    return key;
  }

  /**
   * Ссылка на чтение объекта на `FRAME_URL_TTL_SECONDS`. Подпись считается
   * локально, к R2 это не обращение: срок задаётся параметром `X-Amz-Expires`
   * до подписи, а `signQuery` кладёт подпись в адрес, а не в заголовки.
   */
  async signFrameUrl(key: string): Promise<string> {
    const url = new URL(`${this.endpoint}/${key}`);
    url.searchParams.set("X-Amz-Expires", String(FRAME_URL_TTL_SECONDS));
    const signed = await this.client.sign(url, { method: "GET", aws: { signQuery: true } });
    return signed.url;
  }

  /**
   * Сигнал Worker. Секрет идёт заголовком, а не в теле: тело попадает в
   * журналы прогона, заголовок — нет.
   */
  async notifyReady(callbackUrl: string, secret: string, payload: IngestPayload): Promise<void> {
    await this.postJson(callbackUrl, secret, payload);
  }

  /** Отдельный вызов о неудаче: запись помечается пропущенной и больше не берётся. */
  async notifyFailure(
    callbackUrl: string,
    secret: string,
    failure: { streamId: string; vodId: string; runId: string; code: string; message: string },
  ): Promise<void> {
    await this.postJson(callbackUrl, secret, { ...failure, failed: true });
  }

  private async postJson(url: string, secret: string, body: unknown): Promise<void> {
    await withRetries(async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": secret },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Worker ответил ${response.status} на сигнал прогона`);
      }
    });
  }
}
