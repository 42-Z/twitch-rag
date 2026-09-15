/**
 * Автоматическое пополнение базы (US2).
 *
 * Раз в час: получить список записей канала, вычесть уже разобранные и
 * пропущенные, взять самую раннюю необработанную и запустить разбор.
 * За один запуск берётся одна запись — иначе параллельный разбор съедал бы
 * квоту процессорного времени бокса.
 */

import type { Services } from "./env.ts";
import { startStreamIngest } from "./routes/streams.ts";
import { MAX_ATTEMPTS, isStale, type StreamRecord } from "../shared/registry.ts";
import type { TwitchVideo } from "../shared/twitch.ts";

/**
 * Отбор одной записи к разбору из списка канала и текущего реестра.
 * Вынесено отдельно от сетевых вызовов, чтобы решение проверялось без них.
 */
export function selectNextVideo(
  videos: readonly TwitchVideo[],
  known: ReadonlyMap<string, StreamRecord>,
  watchFrom: number,
  nowUnix: number,
): TwitchVideo | undefined {
  const candidates = videos.filter((video) => {
    const record = known.get(video.vodId);

    if (record === undefined) {
      // Новая запись — берётся только если появилась после подключения канала (FR-003).
      return video.publishedAtUnix >= watchFrom;
    }
    if (record.status === "ready" || record.status === "skipped") return false;
    if (record.status === "processing") return isStale(record, nowUnix);
    // failed: повторяется, пока не исчерпаны попытки.
    return record.attempts < MAX_ATTEMPTS;
  });

  if (candidates.length === 0) return undefined;
  // Самая ранняя необработанная — чтобы база росла по порядку эфиров.
  return candidates.reduce((earliest, video) =>
    video.publishedAtUnix < earliest.publishedAtUnix ? video : earliest,
  );
}

export async function runScheduledCheck(services: Services, callbackBaseUrl: string): Promise<void> {
  const channel = await services.registry.getChannel();
  if (channel === undefined) return; // канал ещё не указан — не ошибка, просто нечего делать

  try {
    const videos = await services.twitch.listArchiveVideos(channel.twitchUserId, 20);

    const knownIds = await services.registry.knownVodIds();
    const known = new Map<string, StreamRecord>();
    for (const id of knownIds) {
      const record = await services.registry.getStream(id);
      if (record !== undefined) known.set(id, record);
    }

    const next = selectNextVideo(videos, known, channel.watchFrom, Math.floor(Date.now() / 1000));
    if (next !== undefined) {
      const previousAttempts = known.get(next.vodId)?.attempts ?? 0;
      await startStreamIngest(next.vodId, "auto", services, callbackBaseUrl, previousAttempts);
    }

    await services.registry.recordCheck({ at: Math.floor(Date.now() / 1000) });
  } catch (error) {
    // Отсутствие новых записей — не ошибка; сбой опроса — тоже не повод
    // останавливать всё остальное, но должен быть виден на странице.
    const message = error instanceof Error ? error.message : String(error);
    await services.registry.recordCheck({ at: Math.floor(Date.now() / 1000), error: message });
  }
}
