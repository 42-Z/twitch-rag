/**
 * Бокс: единственное место, где выполняется то, что невозможно в изоляте V8, —
 * скачивание записи (`yt-dlp`) и нарезка аудио (`ffmpeg`).
 *
 * Всё остальное делает Worker. Бокс не знает ни о векторной базе, ни о
 * документах: он кладёт куски в хранилище и сообщает Worker, что можно
 * начинать.
 */

import { Box } from "@upstash/box";
import { AppError, upstreamError } from "./errors.ts";

export interface BoxConfig {
  boxId: string;
  apiKey: string;
}

/** Путь к собранному прогону внутри бокса. */
export const PIPELINE_PATH = "/workspace/home/pipeline.js";

export class BoxRunner {
  constructor(private readonly config: BoxConfig) {}

  /**
   * Прогон запускается откреплённым: он длится минуты, и Worker не должен
   * висеть всё это время. О результате бокс сообщит сам — вызовом
   * `/api/internal/ingest-ready`.
   */
  async startIngest(input: { vodId: string; url: string; callbackUrl: string }): Promise<void> {
    const command =
      `( node ${PIPELINE_PATH}` +
      ` --vod ${shellArg(input.vodId)}` +
      ` --url ${shellArg(input.url)}` +
      ` --callback ${shellArg(input.callbackUrl)}` +
      ` > /workspace/home/ingest-${shellArg(input.vodId)}.log 2>&1 & )`;

    await this.withRetries(async () => {
      const box = await Box.get(this.config.boxId, { apiKey: this.config.apiKey });
      const run = await box.exec.command(command);
      if (run.exitCode !== null && run.exitCode !== 0) {
        throw new AppError("upstream_unavailable", "Бокс не смог запустить разбор записи.", {
          hint: run.stderr.slice(0, 200),
        });
      }
    });
  }

  async healthy(): Promise<boolean> {
    try {
      await Box.get(this.config.boxId, { apiKey: this.config.apiKey });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * API бокса нестабилен: при проверках два обращения из семи возвращали
   * `fetch failed` и проходили при повторе. Поэтому повторы — не роскошь.
   */
  private async withRetries<T>(action: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        if (attempt < attempts) await sleep(attempt * 500);
      }
    }
    throw upstreamError("бокс", lastError);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Аргумент для команды бокса. Значения приходят из наших же данных, но
 * идентификатор записи попадает в систему снаружи, а команда уходит в
 * оболочку — поэтому проверяется состав, а не экранируется результат.
 */
function shellArg(value: string): string {
  if (!/^[A-Za-z0-9:/?=._-]+$/.test(value)) {
    throw new AppError("invalid_input", "Недопустимое значение для запуска разбора.");
  }
  return value;
}
