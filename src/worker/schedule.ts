/**
 * Автоматическое пополнение базы (US2).
 *
 * Раз в час: получить список записей канала, вычесть уже разобранные и
 * пропущенные, взять самую раннюю необработанную и запустить разбор.
 * За один запуск берётся одна запись — иначе параллельный разбор съедал бы
 * квоту процессорного времени бокса.
 */

import type { Services } from "./env.ts";
import { AppError } from "../shared/errors.ts";
import { startStreamIngest } from "./routes/streams.ts";
import { MAX_ATTEMPTS, isStale, type StreamRecord } from "../shared/registry.ts";
import type { TwitchVideo } from "../shared/twitch.ts";

/**
 * Отбор одной записи к разбору из списка канала и текущего реестра.
 * Вынесено отдельно от сетевых вызовов, чтобы решение проверялось без них.
 *
 * `liveStreamId` — эфир, идущий прямо сейчас (`undefined`, если канал не в
 * эфире). Площадка заводит запись архива в первые секунды трансляции, и та
 * растёт до её конца; такая запись не берётся, иначе в базу попал бы обрывок,
 * а сама запись, помеченная разобранной, больше не рассматривалась бы — и
 * остаток эфира пропал бы навсегда.
 */
export function selectNextVideo(
  videos: readonly TwitchVideo[],
  known: ReadonlyMap<string, StreamRecord>,
  watchFrom: number,
  nowUnix: number,
  liveStreamId?: string,
): TwitchVideo | undefined {
  const candidates = videos.filter((video) => {
    if (liveStreamId !== undefined && video.streamId === liveStreamId) return false;

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

/**
 * Сколько записей канала запрашивать за один раз и сколько страниц подряд
 * просматривать. Одна страница — это окно, за которое при простое успевают
 * появиться новые эфиры: за неделю простоя их набирается больше двадцати, и
 * всё, что оказалось за окном, в реестр не попадало вовсе — в базе возникала
 * дыра, о которой нигде не было ни строчки. Просмотр идёт до первой известной
 * записи, поэтому в обычной работе стоит одной страницы.
 */
const ARCHIVE_PAGE = 20;
const ARCHIVE_MAX_PAGES = 5;

/**
 * Исчерпавшие попытки переводятся в пропущенные с причиной — этого требует
 * модель данных. Без перехода запись навсегда оставалась «неудачной»: в
 * списке владельца она висела как недоделанная, а в сводке знаний не
 * считалась ни разобранной, ни пропущенной.
 *
 * Причина пишется своя, а не берётся из прежней. Прежняя говорит, что запись
 * попробуют разобрать заново, и это правда ровно до этого перехода: дальше
 * автоматика к пропущенной записи не возвращается, и оставленная причина
 * обещала бы то, чего не будет. Что запись можно вернуть вручную — сказано
 * затем, чтобы владелец не остался с пропуском без выхода.
 */
const EXHAUSTED_REASON = "Разбор не удался за отведённое число попыток. Разобрать запись заново можно вручную.";

export async function retireExhausted(known: Map<string, StreamRecord>, services: Services): Promise<void> {
  for (const [vodId, record] of known) {
    if (record.status !== "failed" || record.attempts < MAX_ATTEMPTS) continue;
    await services.registry.patchStream(vodId, { status: "skipped", reason: EXHAUSTED_REASON });
    known.set(vodId, { ...record, status: "skipped", reason: EXHAUSTED_REASON });
  }
}

export async function runScheduledCheck(services: Services, callbackBaseUrl: string): Promise<void> {
  const channel = await services.registry.getChannel();
  if (channel === undefined) return; // канал ещё не указан — не ошибка, просто нечего делать

  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const knownIds = await services.registry.knownVodIds();
    const known = new Map<string, StreamRecord>();
    for (const id of knownIds) {
      const record = await services.registry.getStream(id);
      if (record !== undefined) known.set(id, record);
    }

    await retireExhausted(known, services);

    const videos = await services.twitch.listArchive(channel.twitchUserId, {
      pageSize: ARCHIVE_PAGE,
      maxPages: ARCHIVE_MAX_PAGES,
      // Просмотр прекращается, как только в списке показалась известная
      // запись: значит, до более старых мы уже добрались в прошлые разы.
      stopAt: (video) => known.has(video.vodId),
    });

    // Спрашивается до отбора: если эфир идёт, его растущую запись брать
    // нельзя. Сбой этого запроса валит всю проверку — так задумано: принять
    // обрывок за целый эфир хуже, чем пропустить час.
    const liveStreamId = await services.twitch.getLiveStreamId(channel.twitchUserId);

    const next = selectNextVideo(videos, known, channel.watchFrom, nowUnix, liveStreamId);
    if (next !== undefined) {
      const previousAttempts = known.get(next.vodId)?.attempts ?? 0;
      try {
        await startStreamIngest(next.vodId, "auto", services, callbackBaseUrl, previousAttempts);
      } catch (error) {
        // Разбор этой записи уже идёт — исход гонки, а не сбой проверки:
        // отбор строится по реестру, прочитанному в начале, и запись могла
        // начать разбираться за эти секунды. Отказ запуска — то, чего мы и
        // хотели; в отчёт об ошибке опроса он попадать не должен.
        if (!(error instanceof AppError) || error.code !== "busy") throw error;
      }
    }

    await services.registry.recordCheck({ at: nowUnix });
  } catch (error) {
    // Отсутствие новых записей — не ошибка; сбой опроса — тоже не повод
    // останавливать всё остальное, но должен быть виден на странице.
    // Причина при этом остаётся в журнале: отметка о проверке читается
    // публичным токеном, и текст ошибки увидел бы любой посетитель.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[опрос] ${message}`);
    await services.registry.recordCheck({
      at: Math.floor(Date.now() / 1000),
      error: "Проверка новых записей не удалась. Следующая будет через час.",
    });
  }
}
