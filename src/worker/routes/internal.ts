/**
 * Служебные вызовы от бокса.
 *
 * Единственный клиент — прогон в боксе, аутентифицированный общим секретом,
 * а не токеном владельца: это внутренняя связь между двумя частями одного
 * сервиса, а не операция человека.
 */

import { AppError } from "../../shared/errors.ts";
import { parseStreamId } from "../../shared/stream-id.ts";
import type { TimeRange } from "../../shared/categories.ts";
import type { Frame } from "../../shared/frames.ts";
import type { Env, IngestParams, Services } from "../env.ts";

export interface IngestReadyBody {
  /** Номер записи на площадке. */
  vodId: string;
  /**
   * Запись реестра. Нет у сигнала прежней программы конвейера (она про части
   * не знает) — тогда это неделёная запись и `streamId` равен `vodId`.
   */
  streamId?: string;
  /** Начало отрезка от начала эфира. Нет у прежней программы — тогда 0. */
  partStartSeconds?: number;
  /** Имя прогона бокса: из него складывается имя инстанса разбора. */
  runId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  categories: Array<{ title: string; startSeconds: number; endSeconds: number }>;
  chunks: Array<{ index: number; key: string; offsetSeconds: number; durationSeconds: number }>;
  /**
   * Кадры эфира: ссылки на объекты в R2. Нет у прежней программы конвейера.
   * Тип `unknown` намеренно: боксу доверен общий секрет, но не форма ссылок,
   * которые дальше скачивает чужой сервис (`requireFrames`).
   */
  frames?: unknown;
}

export interface IngestFailedBody {
  vodId: string;
  /** Как у сигнала готовности: нет у прежней программы. */
  streamId?: string;
  failed: true;
  code: string;
  message: string;
  /** Номер захода. Отсутствует у прогонов прежней сборки — тогда отказ берётся как есть. */
  runId?: string;
}

export function requireIngestSecret(request: Request, env: Env): void {
  const provided = request.headers.get("x-ingest-secret");
  if (provided === null || provided !== env.INGEST_SECRET) {
    throw new AppError("invalid_input", "Неверный или отсутствующий секрет прогона.");
  }
}

function isFailure(body: unknown): body is IngestFailedBody {
  return typeof body === "object" && body !== null && (body as { failed?: unknown }).failed === true;
}

/** Коды отказа бокса, после которых запись брать больше не нужно (`pipeline/media.ts`). */
const PERMANENT_FAILURES = new Set(["subscriber_only", "not_found", "geo_blocked"]);

/**
 * Что владелец видит вместо сообщения бокса.
 *
 * Текст берётся свой, а не присланный: бокс — сторона, которой мы не
 * распоряжаемся, а причина ложится в реестр, который читается публичным
 * токеном. Незнакомый код тоже получает свою фразу, а не пришедшую строку.
 */
const FAILURE_REASONS: Record<string, string> = {
  subscriber_only: "Запись доступна только подписчикам канала.",
  not_found: "Запись удалена или недоступна.",
  geo_blocked: "Запись недоступна из этого региона.",
  download_failed: "Запись не удалось скачать. Попробуем ещё раз.",
};

/** Отказ, о котором ничего не известно, — считается временным и повторяется. */
const UNKNOWN_FAILURE_REASON = "Запись не удалось подготовить. Попробуем ещё раз.";

/**
 * Пропала ли запись навсегда — по ответу площадки, а не по словам в чужом выводе.
 *
 * `yt-dlp` говорит «not found» и про удалённую запись, и про ту, которую
 * площадка не отдала сию минуту: разбор идёт по словам, а слова одни и те же.
 * Принять это за приговор значит потерять целый эфир из-за минутной заминки —
 * так и случилось с записью, которая через час скачалась без единой жалобы.
 *
 * Спрашивается площадка: она отвечает про саму запись, а не про то, как прошла
 * одна попытка скачивания. Приговором считается только её прямой ответ, что
 * записи нет; любая другая неудача — сеть, токен, что угодно — признаётся
 * временной. Ошибиться в сторону повтора дешевле, чем потерять эфир.
 */
async function goneForGood(services: Services, vodId: string): Promise<boolean> {
  try {
    await services.twitch.getVideo(vodId);
    return false;
  } catch (error) {
    return error instanceof AppError && error.code === "vod_unavailable";
  }
}

/**
 * Инстанс Workflow называется по записи и прогону: `create` с занятым именем
 * бросает ошибку, и это ровно нужный признак повтора. Реестр для дедупликации
 * не годится — запись уже стоит в `processing` с того момента, как разбор
 * запущен (`startStreamIngest`), то есть ко времени этого сигнала она
 * `processing` всегда, и по одному этому нельзя отличить первый вызов от
 * повторного.
 *
 * Имя прогона обязательно: по одному только идентификатору записи повторный разбор записи
 * упирался бы в имя прошлого — оно занято навсегда, метода удаления инстанса
 * в API Workers нет. Из-за этого не работали ни повтор после сбоя, ни
 * повторный разбор вручную: сигнал приходил, а разбор молча не начинался.
 */
function workflowInstanceId(streamId: string, runId: string): string {
  return `ingest-${streamId}-${runId}`;
}

/** Начался ли разбор этого захода. */
async function instanceStarted(env: Env, streamId: string, runId: string): Promise<boolean> {
  try {
    await env.INGEST.get(workflowInstanceId(streamId, runId));
    return true;
  } catch {
    // Нет разбора — нет и запоздания: обычный отказ, его и применяем.
    return false;
  }
}

/** Имя прогона идёт в идентификатор инстанса, поэтому форма проверяется. */
function requireRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(value)) {
    throw new AppError("invalid_input", "В сигнале прогона нет опознаваемого runId.");
  }
  return value;
}

/**
 * Сигнал о готовности кусков либо об отказе бокса.
 *
 * Повторный вызов для записи, чей инстанс уже создан, отвечает 200 без
 * создания нового — бокс мог повторить сигнал после сбоя сети.
 */
export async function handleIngestReady(request: Request, env: Env, services: Services): Promise<Response> {
  requireIngestSecret(request, env);

  const body = await parseBody(request);

  if (isFailure(body)) {
    const { streamId, vodId } = identify(body);
    // Пропуск без возврата — только для того, что не изменится: запись
    // закрыта для подписчиков, удалена или недоступна из этого региона
    // (FR-006). Сбой скачивания временный: пометив его пропуском, мы
    // выбрасывали бы запись навсегда, тогда как спецификация требует
    // оставить её необработанной и взять позже (FR-002). Неизвестный код
    // считается временным — ошибиться в сторону повтора дешевле.
    // «Не найдена» проверяется у площадки: этот отказ неотличим от минутной
    // заминки по словам, а цена ошибки — потерянный эфир. Остальные коды
    // говорят о самой записи (закрыта для подписчиков, недоступна из региона)
    // и в проверке не нуждаются.
    const permanent =
      body.code === "not_found"
        ? await goneForGood(services, vodId)
        : PERMANENT_FAILURES.has(body.code);
    const status = permanent ? "skipped" : "failed";
    // Присланное боксом сообщение остаётся в журнале: в реестр идёт своя
    // фраза, потому что реестр читается публичным токеном.
    console.error(`[разбор ${streamId}] отказ бокса ${body.code}: ${body.message}`);

    // Отказ, пришедший после того, как разбор этого же захода уже начался, —
    // запоздавший: это тот заход, у которого не дошёл ответ на сигнал
    // готовности. Помечать запись отказавшей нельзя: разбор идёт, а помеченная
    // запись попадёт под автоматический повтор и пойдёт второй раз (FR-029).
    if (body.runId !== undefined && (await instanceStarted(env, streamId, body.runId))) {
      console.error(`[разбор ${streamId}] отказ захода ${body.runId} запоздал — разбор уже идёт`);
      return Response.json({ streamId, vodId, status: "processing" });
    }

    await services.registry.patchStream(streamId, {
      status,
      reason: FAILURE_REASONS[body.code] ?? UNKNOWN_FAILURE_REASON,
      processedAt: nowUnix(),
    });
    return Response.json({ streamId, vodId, status });
  }

  const payload = body as IngestReadyBody;
  if (payload.vodId === undefined || payload.vodId === "") {
    throw new AppError("invalid_input", "В сигнале прогона нет vodId.");
  }
  const { streamId, vodId } = identify(payload);
  const runId = requireRunId(payload.runId);

  const existing = await services.registry.getStream(streamId);

  // Часть эфира: её запись положил запуск разбора, и общее число частей лежит
  // в ней — бокс его не знает. Нет записи — сигнал не от нашего запуска.
  const partStartSeconds = requirePartStart(payload.partStartSeconds);
  const partNumber = parseStreamId(streamId).part;
  let part: { index: number; count: number } | undefined;
  if (partNumber !== undefined) {
    if (existing?.partCount === undefined) {
      throw new AppError("invalid_input", "Такой части эфира в реестре нет.");
    }
    part = { index: partNumber, count: existing.partCount };
  }

  // Время части — время эфира плюс её начало: части одного эфира встают в
  // индексе рядом и по порядку.
  const publishedAtUnix = Math.floor(new Date(payload.publishedAt).getTime() / 1000) + partStartSeconds;
  const publishedAt = partStartSeconds === 0 ? payload.publishedAt : new Date(publishedAtUnix * 1000).toISOString();

  const frames = requireFrames(payload.frames, streamId, {
    startSeconds: partStartSeconds,
    endSeconds: partStartSeconds + payload.durationSeconds,
  });

  // Заголовок из сигнала бокса в разбор не передаётся: он не участвует ни в
  // документе, ни в имени (FR-027) и остаётся служебным полем реестра.
  const params: IngestParams = {
    streamId,
    vodId,
    partStartSeconds,
    ...(part === undefined ? {} : { part }),
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt,
    durationSeconds: payload.durationSeconds,
    categories: payload.categories,
    chunks: payload.chunks,
    // Только когда кадры есть: пустой список равен отсутствию поля.
    ...(frames.length === 0 ? {} : { frames }),
  };

  let instanceId: string;
  try {
    const instance = await env.INGEST.create({ id: workflowInstanceId(streamId, runId), params });
    instanceId = instance.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/exist/i.test(message)) {
      // Не про занятый id — настоящий сбой, а не повтор сигнала.
      throw new AppError("upstream_unavailable", "Не удалось создать инстанс разбора.", { cause: error });
    }
    return Response.json({ streamId, vodId, status: "processing" });
  }

  // Реестр трогается только после того, как разбор действительно создан:
  // запись на этот момент уже стоит в `processing` (её поставил запуск), а
  // повторный сигнал, случившийся после успеха, иначе возвращал бы готовую
  // запись обратно в `processing` и поднимал бы число попыток.
  await services.registry.putStream({
    streamId,
    vodId,
    status: "processing",
    title: payload.title,
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt,
    publishedAtUnix,
    durationSeconds: payload.durationSeconds,
    categories: payload.categories,
    ...(part === undefined ? {} : { part: part.index, partCount: part.count, partStartSeconds }),
    source: existing?.source ?? "manual",
    // Попытка здесь не считается: её уже зачёл запуск разбора
    // (`startStreamIngest`), а сигнал бокса — это тот же самый заход, а не
    // новый. Второй счёт съедал попытки вдвое быстрее заявленного.
    attempts: existing?.attempts ?? 1,
    processedAt: nowUnix(),
  });

  return Response.json({ streamId, vodId, status: "processing", instanceId }, { status: 202 });
}

/**
 * Какая запись реестра и какая запись площадки стоят за сигналом.
 *
 * Идентификатор из сигнала проходит ту же проверку, что и везде, а его номер
 * записи обязан совпасть с полем `vodId`: иначе сигнал мог бы указать одну
 * запись площадки, а лечь в реестр под чужим ключом.
 */
function identify(body: { vodId: string; streamId?: string }): { streamId: string; vodId: string } {
  const streamId = body.streamId ?? body.vodId;
  const parsed = parseStreamId(streamId);
  if (parsed.vodId !== body.vodId) {
    throw new AppError("invalid_input", "Идентификатор записи в сигнале не совпадает с номером записи.");
  }
  return { streamId, vodId: parsed.vodId };
}

/** Подписанная ссылка R2 — 385 знаков; запас до тысячи, дальше это не ссылка. */
const MAX_FRAME_URL_LENGTH = 1000;
/** Штатно кадров не больше 120 (часть до шести часов); 400 — потолок на случай ошибки бокса. */
const MAX_FRAMES_IN_SIGNAL = 400;
/** Домен, на котором R2 отдаёт подписанные адреса S3 (`research.md` §2). */
const R2_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/**
 * Кадры из сигнала бокса: остаётся только то, что прошло проверки.
 *
 * Сигнал аутентифицирован общим секретом, но ссылки из него уходят дальше —
 * их скачивает чужой сервис, — поэтому каждая проверяется: форма, адрес
 * (https, домен R2, путь кадров именно этой записи), время внутри отрезка,
 * повторы секунд. Негодная запись **отбрасывается одна, а сигнал принимается**:
 * разбор важнее одной картинки (FR-016). Отброшенное считается недобытым и
 * попадает в учёт «без кадров». В журнал идёт число отброшенных, не адреса.
 */
export function requireFrames(value: unknown, streamId: string, range: TimeRange): Frame[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.warn(`[разбор ${streamId}] поле кадров не массив — кадров нет`);
    return [];
  }

  const pathMarker = `/frames/${streamId}/`;
  const seen = new Set<number>();
  const accepted: Frame[] = [];
  for (const entry of value as unknown[]) {
    const frame = readFrame(entry);
    if (frame === undefined) continue;
    if (frame.atSeconds < range.startSeconds || frame.atSeconds >= range.endSeconds) continue;
    if (!isOwnFrameUrl(frame.url, pathMarker)) continue;
    // Повтор той же секунды: остаётся первый.
    if (seen.has(frame.atSeconds)) continue;
    seen.add(frame.atSeconds);
    accepted.push(frame);
  }

  // Больше потолка — остаются первые по времени, а не по порядку в сигнале.
  const frames = accepted.sort((a, b) => a.atSeconds - b.atSeconds).slice(0, MAX_FRAMES_IN_SIGNAL);
  if (frames.length < value.length) {
    console.warn(`[разбор ${streamId}] кадров отброшено при приёме: ${value.length - frames.length}`);
  }
  return frames;
}

/** Форма записи: объект с целым `atSeconds ≥ 0` и строкой `url` не длиннее предела. */
function readFrame(entry: unknown): Frame | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { atSeconds, url } = entry as { atSeconds?: unknown; url?: unknown };
  if (typeof atSeconds !== "number" || !Number.isSafeInteger(atSeconds) || atSeconds < 0) return undefined;
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_FRAME_URL_LENGTH) return undefined;
  return { atSeconds, url };
}

/**
 * Адрес кадра этой записи: https, хост R2 без чужого порта, в пути — каталог
 * кадров этой записи. Путь берётся из разобранного адреса, где `..` уже
 * свернуты, а не из строки.
 */
function isOwnFrameUrl(raw: string, pathMarker: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.hostname.endsWith(R2_HOST_SUFFIX) &&
    url.pathname.includes(pathMarker)
  );
}

/** Начало отрезка: у сигнала прежней программы поля нет — это неделёная запись. */
function requirePartStart(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError("invalid_input", "В сигнале прогона неверное начало отрезка.");
  }
  return value;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("invalid_input", "Тело сигнала должно быть объектом JSON.");
  }
}
