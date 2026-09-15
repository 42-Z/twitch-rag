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
import { readMediaInfo, MediaUnavailableError, classifyFailure } from "./media.ts";
import { cutAudio } from "./segment.ts";
import { Publisher, audioKey } from "./publish.ts";

interface Args {
  vodId: string;
  url: string;
  callbackUrl: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length - 1; index++) {
    const key = argv[index];
    if (key !== undefined && key.startsWith("--")) values.set(key.slice(2), argv[index + 1] ?? "");
  }
  const vodId = values.get("vod") ?? "";
  const url = values.get("url") ?? "";
  const callbackUrl = values.get("callback") ?? "";
  if (vodId === "" || url === "" || callbackUrl === "") {
    throw new Error("нужны --vod, --url и --callback");
  }
  return { vodId, url, callbackUrl };
}

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

  const workDir = path.join("/workspace/home/work", args.vodId);

  try {
    const info = await readMediaInfo(args.url);
    const chunks = await cutAudio(args.url, workDir);
    if (chunks.length === 0) throw new Error("нарезка не дала ни одного куска");

    await publisher.uploadChunks(args.vodId, workDir, chunks);
    await publisher.notifyReady(args.callbackUrl, secret, {
      vodId: args.vodId,
      title: info.title,
      publishedAt: info.publishedAt,
      durationSeconds: info.durationSeconds,
      categories: info.chapters,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        key: audioKey(args.vodId, chunk.index),
        offsetSeconds: chunk.offsetSeconds,
        durationSeconds: chunk.durationSeconds,
      })),
    });
    console.log(`готово: ${chunks.length} кусков для ${args.vodId}`);
  } catch (error) {
    const reason =
      error instanceof MediaUnavailableError
        ? error.reason
        : classifyFailure(error instanceof Error ? error.message : String(error));
    console.error(`отказ по ${args.vodId}: ${reason.code} — ${reason.message}`);
    await publisher
      .notifyFailure(args.callbackUrl, secret, { vodId: args.vodId, ...reason })
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
