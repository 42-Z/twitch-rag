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

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface IngestPayload {
  vodId: string;
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
}

export function audioKey(vodId: string, index: number): string {
  return `audio/${vodId}/chunk-${String(index).padStart(4, "0")}.m4a`;
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

  async uploadChunks(vodId: string, workDir: string, chunks: readonly AudioChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const body = await readFile(path.join(workDir, chunk.file));
      await this.withRetries(async () => {
        const response = await this.client.fetch(`${this.endpoint}/${audioKey(vodId, chunk.index)}`, {
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
    failure: { vodId: string; runId: string; code: string; message: string },
  ): Promise<void> {
    await this.postJson(callbackUrl, secret, { ...failure, failed: true });
  }

  private async postJson(url: string, secret: string, body: unknown): Promise<void> {
    await this.withRetries(async () => {
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

  private async withRetries<T>(action: () => Promise<T>, attempts = 4): Promise<T> {
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
}
