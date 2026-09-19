/**
 * Служебные вызовы от бокса.
 *
 * Единственный клиент — прогон в боксе, аутентифицированный общим секретом,
 * а не токеном владельца: это внутренняя связь между двумя частями одного
 * сервиса, а не операция человека.
 */

import { AppError } from "../../shared/errors.ts";
import type { Env, IngestParams, Services } from "../env.ts";

export interface IngestReadyBody {
  vodId: string;
  /** Имя прогона бокса: из него складывается имя инстанса разбора. */
  runId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  categories: Array<{ title: string; startSeconds: number; endSeconds: number }>;
  chunks: Array<{ index: number; key: string; offsetSeconds: number; durationSeconds: number }>;
}

export interface IngestFailedBody {
  vodId: string;
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
 * Имя прогона обязательно: по одному только vodId повторный разбор записи
 * упирался бы в имя прошлого — оно занято навсегда, метода удаления инстанса
 * в API Workers нет. Из-за этого не работали ни повтор после сбоя, ни
 * повторный разбор вручную: сигнал приходил, а разбор молча не начинался.
 */
function workflowInstanceId(vodId: string, runId: string): string {
  return `ingest-${vodId}-${runId}`;
}

/** Начался ли разбор этого захода. */
async function instanceStarted(env: Env, vodId: string, runId: string): Promise<boolean> {
  try {
    await env.INGEST.get(workflowInstanceId(vodId, runId));
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
        ? await goneForGood(services, body.vodId)
        : PERMANENT_FAILURES.has(body.code);
    const status = permanent ? "skipped" : "failed";
    // Присланное боксом сообщение остаётся в журнале: в реестр идёт своя
    // фраза, потому что реестр читается публичным токеном.
    console.error(`[разбор ${body.vodId}] отказ бокса ${body.code}: ${body.message}`);

    // Отказ, пришедший после того, как разбор этого же захода уже начался, —
    // запоздавший: это тот заход, у которого не дошёл ответ на сигнал
    // готовности. Помечать запись отказавшей нельзя: разбор идёт, а помеченная
    // запись попадёт под автоматический повтор и пойдёт второй раз (FR-029).
    if (body.runId !== undefined && (await instanceStarted(env, body.vodId, body.runId))) {
      console.error(`[разбор ${body.vodId}] отказ захода ${body.runId} запоздал — разбор уже идёт`);
      return Response.json({ vodId: body.vodId, status: "processing" });
    }

    await services.registry.patchStream(body.vodId, {
      status,
      reason: FAILURE_REASONS[body.code] ?? UNKNOWN_FAILURE_REASON,
      processedAt: nowUnix(),
    });
    return Response.json({ vodId: body.vodId, status });
  }

  const payload = body as IngestReadyBody;
  if (payload.vodId === undefined || payload.vodId === "") {
    throw new AppError("invalid_input", "В сигнале прогона нет vodId.");
  }
  const runId = requireRunId(payload.runId);

  const existing = await services.registry.getStream(payload.vodId);

  // Заголовок из сигнала бокса в разбор не передаётся: он не участвует ни в
  // документе, ни в имени (FR-027) и остаётся служебным полем реестра.
  const params: IngestParams = {
    vodId: payload.vodId,
    url: `https://www.twitch.tv/videos/${payload.vodId}`,
    publishedAt: payload.publishedAt,
    durationSeconds: payload.durationSeconds,
    categories: payload.categories,
    chunks: payload.chunks,
  };

  let instanceId: string;
  try {
    const instance = await env.INGEST.create({ id: workflowInstanceId(payload.vodId, runId), params });
    instanceId = instance.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/exist/i.test(message)) {
      // Не про занятый id — настоящий сбой, а не повтор сигнала.
      throw new AppError("upstream_unavailable", "Не удалось создать инстанс разбора.", { cause: error });
    }
    return Response.json({ vodId: payload.vodId, status: "processing" });
  }

  // Реестр трогается только после того, как разбор действительно создан:
  // запись на этот момент уже стоит в `processing` (её поставил запуск), а
  // повторный сигнал, случившийся после успеха, иначе возвращал бы готовую
  // запись обратно в `processing` и поднимал бы число попыток.
  await services.registry.putStream({
    vodId: payload.vodId,
    status: "processing",
    title: payload.title,
    url: `https://www.twitch.tv/videos/${payload.vodId}`,
    publishedAt: payload.publishedAt,
    publishedAtUnix: Math.floor(new Date(payload.publishedAt).getTime() / 1000),
    durationSeconds: payload.durationSeconds,
    categories: payload.categories,
    source: existing?.source ?? "manual",
    // Попытка здесь не считается: её уже зачёл запуск разбора
    // (`startStreamIngest`), а сигнал бокса — это тот же самый заход, а не
    // новый. Второй счёт съедал попытки вдвое быстрее заявленного.
    attempts: existing?.attempts ?? 1,
    processedAt: nowUnix(),
  });

  return Response.json({ vodId: payload.vodId, status: "processing", instanceId }, { status: 202 });
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
