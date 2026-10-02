/**
 * Точка входа прогона в боксе.
 *
 * Бокс делает ровно то, что невозможно в изоляте V8: скачивает запись, режет
 * звук и снимает кадры эфира. Ни векторной базы, ни документов он не знает —
 * выкладывает куски и кадры и сообщает Worker, что можно начинать.
 *
 * Запускается откреплённым, поэтому о любом исходе обязан сообщить сам:
 * молча умерший прогон оставил бы запись висеть в состоянии «разбирается».
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { readMediaInfo, MediaUnavailableError, classifyFailure, clipChapters } from "./media.ts";
import { cutAudio, absoluteChunks } from "./segment.ts";
import { Publisher, audioKey } from "./publish.ts";
import { collectFrames, createFrameIo, describeError } from "./frames.ts";
import { parseArgs } from "./args.ts";
import type { Frame } from "../shared/frames.ts";

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

    // Кадры — добавка к звуку: любая их неудача даёт пустой список, а не отказ
    // прогона. Сигнал готовности уходит в любом случае, а Worker разбирает эфир
    // по речи и говорит в записи, сколько осталось без кадров.
    let frames: Frame[] = [];
    if (info.frameSource !== undefined) {
      try {
        const collected = await collectFrames({
          source: info.frameSource,
          range: { startSeconds: fromSeconds, endSeconds: toSeconds },
          io: createFrameIo({
            upload: (atSeconds, bytes) => publisher.uploadFrame(args.streamId, atSeconds, bytes),
            sign: (key) => publisher.signFrameUrl(key),
          }),
          log: (message) => console.error(message),
        });
        frames = collected.frames;
        console.log(`кадров: ${collected.frames.length} из ${collected.planned}`);
      } catch (error) {
        console.error(`кадры не добыты: ${describeError(error)}`);
      }
    } else {
      console.log("кадров: нет видеодорожки");
    }

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
      frames,
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
