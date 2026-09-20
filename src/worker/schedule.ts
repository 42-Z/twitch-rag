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
import { nameDocumentsWithoutNames } from "./naming.ts";
import { MAX_ATTEMPTS, isStale, skippedStreamRecord, type StreamRecord } from "../shared/registry.ts";
import { skipReason, type TwitchVideo } from "../shared/twitch.ts";
import { formatStreamId } from "../shared/stream-id.ts";
import { splitIntoParts, type StreamPart } from "../shared/stream-parts.ts";

/** Что взято в разбор: запись площадки и та её часть, до которой дошла очередь. */
export interface NextIngest {
  video: TwitchVideo;
  part: StreamPart;
}

/**
 * Отбор одной части к разбору из списка канала и текущего реестра.
 * Вынесено отдельно от сетевых вызовов, чтобы решение проверялось без них.
 *
 * Эфир длиннее порога делится на части (`stream-parts.ts`), и каждая часть —
 * отдельная запись реестра; отбираются части, а не эфиры. Эфир, который
 * делится, автоматикой не берётся, если в реестре есть неделёная запись под
 * его номером: она осталась от прежней версии и не переразбирается задним
 * числом (FR-015); владелец может разобрать такой эфир вручную.
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
): NextIngest | undefined {
  const candidates: Array<NextIngest & { startsAtUnix: number }> = [];

  for (const video of videos) {
    if (liveStreamId !== undefined && video.streamId === liveStreamId) continue;

    const parts = splitIntoParts(video.durationSeconds);
    const divided = parts.length > 1;
    if (divided && known.has(video.vodId)) continue;

    for (const part of parts) {
      const record = known.get(formatStreamId(video.vodId, divided ? part.index : undefined));
      if (!isCandidate(record, video, watchFrom, nowUnix)) continue;
      candidates.push({ video, part, startsAtUnix: video.publishedAtUnix + part.startSeconds });
    }
  }

  if (candidates.length === 0) return undefined;
  // Самая ранняя необработанная часть — чтобы база росла по порядку эфиров.
  const earliest = candidates.reduce((best, item) => (item.startsAtUnix < best.startsAtUnix ? item : best));
  return { video: earliest.video, part: earliest.part };
}

function isCandidate(
  record: StreamRecord | undefined,
  video: TwitchVideo,
  watchFrom: number,
  nowUnix: number,
): boolean {
  if (record === undefined) {
    // Новая запись — берётся только если эфир начался после подключения канала (FR-003).
    return video.publishedAtUnix >= watchFrom;
  }
  if (record.status === "ready" || record.status === "skipped") return false;
  if (record.status === "processing") return isStale(record, nowUnix);
  // failed: повторяется, пока не исчерпаны попытки.
  return record.attempts < MAX_ATTEMPTS;
}

/**
 * Номера записей площадки, по которым в реестре что-то есть — целыми записями
 * или частями. По ним обход архива останавливается на первой известной записи:
 * у делёного эфира в реестре нет ключа с номером записи, только ключи частей.
 */
export function knownVideoIds(known: ReadonlyMap<string, StreamRecord>): Set<string> {
  return new Set([...known.values()].map((record) => record.vodId));
}

/**
 * Записи, которые разбирать нечего, — чтобы пометить их пропущенными до
 * отбора, а не когда до них дойдёт очередь.
 *
 * За один запуск проверки берётся одна запись к разбору, поэтому помеченный
 * «по очереди» обрывок отнимает час у настоящего эфира: обрывков в архиве
 * канала набралось восемь, и восемь часов эфиры ждали бы зря.
 *
 * Проход смотрит ровно на то, что взял бы в работу сам: записи после
 * подключения канала (FR-003) и не растущую запись идущего эфира. Прошлые
 * эфиры в работу не берутся вовсе — их добавляет владелец, — и записывать их
 * пропущенными значило бы завести в список решения, которых система не
 * принимала. Растущая запись тоже короче трёх минут в первые минуты эфира, и
 * пометить её пропущенной значит потерять весь эфир: разобранную запись
 * автоматика больше не возьмёт.
 */
export function unprocessableToSkip(
  videos: readonly TwitchVideo[],
  known: ReadonlyMap<string, StreamRecord>,
  watchFrom: number,
  liveStreamId?: string,
): TwitchVideo[] {
  return videos.filter((video) => {
    if (known.has(video.vodId)) return false;
    if (video.publishedAtUnix < watchFrom) return false;
    if (liveStreamId !== undefined && video.streamId === liveStreamId) return false;
    return skipReason(video) !== undefined;
  });
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
  for (const [streamId, record] of known) {
    if (record.status !== "failed" || record.attempts < MAX_ATTEMPTS) continue;
    await services.registry.patchStream(streamId, { status: "skipped", reason: EXHAUSTED_REASON });
    known.set(streamId, { ...record, status: "skipped", reason: EXHAUSTED_REASON });
  }
}

export async function runScheduledCheck(services: Services, callbackBaseUrl: string): Promise<void> {
  const channel = await services.registry.getChannel();
  if (channel === undefined) return; // канал ещё не указан — не ошибка, просто нечего делать

  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const knownIds = await services.registry.knownStreamIds();
    const known = new Map<string, StreamRecord>();
    for (const id of knownIds) {
      const record = await services.registry.getStream(id);
      if (record !== undefined) known.set(id, record);
    }

    await retireExhausted(known, services);
    const knownVideos = knownVideoIds(known);

    const videos = await services.twitch.listArchive(channel.twitchUserId, {
      pageSize: ARCHIVE_PAGE,
      maxPages: ARCHIVE_MAX_PAGES,
      // Просмотр прекращается, как только в списке показалась известная
      // запись: значит, до более старых мы уже добрались в прошлые разы.
      stopAt: (video) => knownVideos.has(video.vodId),
    });

    // Спрашивается до отбора: если эфир идёт, его растущую запись брать
    // нельзя. Сбой этого запроса валит всю проверку — так задумано: принять
    // обрывок за целый эфир хуже, чем пропустить час.
    const liveStreamId = await services.twitch.getLiveStreamId(channel.twitchUserId);

    // Помечается до отбора и после вопроса об идущем эфире: растущая запись
    // идущего эфира короче трёх минут, и без этого вопроса её пометили бы
    // пропущенной вместе с обрывками.
    for (const video of unprocessableToSkip(videos, known, channel.watchFrom, liveStreamId)) {
      const reason = skipReason(video);
      if (reason === undefined) continue; // недостижимо: отбор проверяет то же
      const record = skippedStreamRecord(video, "auto", reason);
      await services.registry.putStream(record);
      known.set(record.streamId, record);
    }

    const next = selectNextVideo(videos, known, channel.watchFrom, nowUnix, liveStreamId);
    if (next !== undefined) {
      const streamId = formatStreamId(next.video.vodId, next.part.count > 1 ? next.part.index : undefined);
      const previousAttempts = known.get(streamId)?.attempts ?? 0;
      try {
        await startStreamIngest(streamId, "auto", services, callbackBaseUrl, previousAttempts);
      } catch (error) {
        // Разбор этой записи уже идёт — исход гонки, а не сбой проверки:
        // отбор строится по реестру, прочитанному в начале, и запись могла
        // начать разбираться за эти секунды. Отказ запуска — то, чего мы и
        // хотели; в отчёт об ошибке опроса он попадать не должен.
        if (!(error instanceof AppError) || error.code !== "busy") throw error;
      }
    }

    // Имена документам, разобранным до их появления (FR-022). Стоит после
    // отбора: работа разовая и не должна задерживать поиск новых записей.
    await nameDocumentsWithoutNames(known.values(), services);

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
