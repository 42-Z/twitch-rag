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

/**
 * Рабочий каталог бокса: в нём лежат собранный прогон, его секреты и журналы
 * заходов.
 *
 * Прогон — `pipeline.mjs`, а не `.js`: сборка использует верхнеуровневый
 * `await`, и без него Node решал бы модуль как CommonJS в зависимости от
 * `package.json` рабочего каталога бокса.
 *
 * Секреты — файлом `.env.pipeline`, а не в командной строке: `box env set`
 * держит только переменные, заданные при создании бокса, а прогон бокса уже
 * существует. Команда `ps` внутри бокса иначе показала бы секрет любому, кто
 * туда заглянет.
 */
export const BOX_HOME = "/workspace/home";

export class BoxRunner {
  private readonly config: BoxConfig;

  constructor(config: BoxConfig) {
    this.config = config;
  }

  /**
   * Прогон запускается откреплённым: он длится минуты, и Worker не должен
   * висеть всё это время. О результате бокс сообщит сам — вызовом
   * `/api/internal/ingest-ready`.
   */
  async startIngest(input: { vodId: string; url: string; callbackUrl: string }): Promise<void> {
    const vodId = requireVodId(input.vodId);
    const url = requireHttpsUrl(input.url, "адрес записи");
    const callbackUrl = requireHttpsUrl(input.callbackUrl, "адрес обратного вызова");

    // Журнал именуется по заходу, а не по записи: повторный запуск по той же
    // записи не должен затирать след предыдущего — однажды именно так и
    // пропали сведения о том, почему разбор пошёл двумя копиями.
    const attempt = Date.now().toString(36);

    const command = buildIngestCommand({ vodId, url, callbackUrl, attempt });

    await this.withRetries(async () => {
      const box = await Box.get(this.config.boxId, { apiKey: this.config.apiKey });
      const run = await box.exec.command(command);
      if (run.exitCode !== null && run.exitCode !== 0) {
        // Вывод оболочки — в журнал, а не в тело ответа: оттуда он попал бы
        // наружу, а что именно печатает бокс, мы не решаем.
        console.error(`[бокс] запуск разбора не удался: ${run.stderr.slice(0, 500)}`);
        throw new AppError("upstream_unavailable", "Бокс не смог запустить разбор записи.");
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
 * Команда запуска прогона в боксе.
 *
 * Вынесена отдельно от самого запуска, потому что её и надо проверять: на
 * живом боксе ошибку в ней видно только по тому, что разбор не начался, а
 * причина при этом никуда не попадает.
 *
 * Проверка стоит перед откреплённым запуском, а не после него. Подоболочка
 * `( … & )` — документированный способ отцепить процесс — завершается сразу и
 * всегда с нулём: `( нет-такой-команды & )` тоже даёт ноль. Поэтому о судьбе
 * откреплённого запуска код возврата не говорит ничего, и «нет файла прогона»
 * проходило бы молча, а Worker ждал бы обратного вызова, которого не будет.
 */
export function buildIngestCommand(input: {
  vodId: string;
  url: string;
  callbackUrl: string;
  attempt: string;
  /** Рабочий каталог. Меняется только в проверке, где бокса нет. */
  home?: string;
}): string {
  const home = input.home ?? BOX_HOME;
  return (
    `if [ ! -f ${home}/pipeline.mjs ]; then echo "нет файла прогона" >&2; exit 3; fi; ` +
    `if [ ! -f ${home}/.env.pipeline ]; then echo "нет файла секретов" >&2; exit 4; fi; ` +
    `( node --env-file=${home}/.env.pipeline ${home}/pipeline.mjs` +
    ` --vod '${input.vodId}'` +
    ` --url '${input.url}'` +
    ` --callback '${input.callbackUrl}'` +
    ` > ${home}/ingest-${input.vodId}-${input.attempt}.log 2>&1 & )`
  );
}

/**
 * Значения уходят в командную оболочку бокса, а идентификатор записи ещё и
 * становится частью пути к журналу. Поэтому каждое проверяется по своей форме,
 * а не общим набором «безопасных символов»: набор, разрешающий точку и слэш,
 * пропускает и `../..`, и подстановку чужого пути.
 */
function requireVodId(value: string): string {
  if (!/^\d{1,20}$/.test(value)) {
    throw new AppError("invalid_input", "Идентификатор записи Twitch состоит только из цифр.");
  }
  return value;
}

function requireHttpsUrl(value: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("invalid_input", `Неверный ${what}.`);
  }
  // Кавычка или перевод строки вырвались бы из одинарных кавычек команды.
  if (parsed.protocol !== "https:" || /['"\\\s]/.test(value)) {
    throw new AppError("invalid_input", `Неверный ${what}: ожидается адрес https без пробелов.`);
  }
  return value;
}
