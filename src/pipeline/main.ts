/**
 * Точка входа прогона в боксе.
 *
 * Бокс делает ровно то, что невозможно в изоляте V8: скачивает запись и режет
 * звук. Ни векторной базы, ни документов он не знает — выкладывает куски и
 * сообщает Worker, что можно начинать.
 *
 * Запускается откреплённым, поэтому о любом исходе обязан сообщить сам:
 * молча умерший прогон оставил бы запись висеть в состоянии «разбирается».
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { readMediaInfo, MediaUnavailableError, classifyFailure, clipChapters } from "./media.ts";
import { cutAudio, absoluteChunks } from "./segment.ts";
import { Publisher, audioKey } from "./publish.ts";
import { parseArgs } from "./args.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`не задана переменная ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secret = requireEnv("INGEST_SECRET");

  const publisher = new Publisher({
    accountId: requireEnv("R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    bucket: process.env["R2_BUCKET"] ?? "twitch-audio",
  });

  const workDir = path.join("/workspace/home/work", args.streamId);
  // Имя этому прогону: по нему Worker отличит повторный сигнал одного прогона
  // от нового разбора той же записи (`publish.ts`).
  const runId = crypto.randomUUID();

  try {
    const info = await readMediaInfo(args.url);
    // Отрезок эфира: прежняя программа сервиса границ не передаёт — тогда весь эфир.
    const fromSeconds = args.fromSeconds ?? 0;
    const toSeconds = Math.min(args.toSeconds ?? info.durationSeconds, info.durationSeconds);
    if (fromSeconds >= toSeconds) {
      throw new Error(`отрезок ${fromSeconds}–${toSeconds} с пуст: в записи ${info.durationSeconds} с`);
    }
    // Нарезка считает время от начала отрезка; ниже по течению время везде
    // абсолютное, от начала эфира, и помнить, от чего отсчитана метка, не нужно.
    const chunks = absoluteChunks(await cutAudio(args.url, workDir, { fromSeconds, toSeconds }), fromSeconds);
    if (chunks.length === 0) throw new Error("нарезка не дала ни одного куска");

    await publisher.uploadChunks(args.streamId, workDir, chunks);
    await publisher.notifyReady(args.callbackUrl, secret, {
      streamId: args.streamId,
      vodId: args.vodId,
      partStartSeconds: fromSeconds,
      runId,
      title: info.title,
      publishedAt: info.publishedAt,
      // Длина отрезка, а не всего эфира; главы — только его, в абсолютном времени.
      durationSeconds: toSeconds - fromSeconds,
      categories: clipChapters(info.chapters, fromSeconds, toSeconds),
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        key: audioKey(args.streamId, chunk.index),
        offsetSeconds: chunk.offsetSeconds,
        durationSeconds: chunk.durationSeconds,
      })),
    });
    console.log(`готово: ${chunks.length} кусков для ${args.streamId}`);
  } catch (error) {
    const reason =
      error instanceof MediaUnavailableError
        ? error.reason
        : classifyFailure(error instanceof Error ? error.message : String(error));
    console.error(`отказ по ${args.streamId}: ${reason.code} — ${reason.message}`);
    // Номер прогона идёт и здесь: по нему Worker отличает отказ этого захода
    // от запоздавшего отказа прошлого, когда разбор уже начался.
    await publisher
      .notifyFailure(args.callbackUrl, secret, { streamId: args.streamId, vodId: args.vodId, runId, ...reason })
      .catch((notifyError: unknown) => {
        console.error("не удалось сообщить Worker об отказе:", notifyError);
      });
    process.exitCode = 1;
  } finally {
    // Временные файлы убираются при любом исходе: у бокса общий диск,
    // и брошенное аудио копилось бы от прогона к прогону.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
