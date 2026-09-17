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
    const permanent = PERMANENT_FAILURES.has(body.code);
    const status = permanent ? "skipped" : "failed";
    await services.registry.patchStream(body.vodId, {
      status,
      reason: body.message,
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
