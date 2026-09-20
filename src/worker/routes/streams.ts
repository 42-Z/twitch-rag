/**
 * Операции владельца над записями: ручное добавление, документ трансляции,
 * удаление, повторный разбор. Разбор новых записей запускается отсюда же,
 * что и из расписания (`schedule.ts`) — общий код в `startStreamIngest`.
 */

import { z } from "zod";
import { AppError } from "../../shared/errors.ts";
import { MAX_ATTEMPTS, isStale, skippedStreamRecord, type StreamRecord } from "../../shared/registry.ts";
import { skipReason } from "../../shared/twitch.ts";
import { parseStreamId, requireStreamId } from "../../shared/stream-id.ts";
import type { Env, Services } from "../env.ts";
import { parseJson, requireAdminToken } from "./owner.ts";

/**
 * Идёт ли по записи разбор прямо сейчас.
 *
 * Проверка нужна в нескольких местах и по одной причине: второй разбор той
 * же записи запускать нельзя — два конвейера пишут куски в одну папку бокса и
 * портят друг другу работу. Брошенная запись (в `processing` дольше суток)
 * разбором не считается: её как раз и надо взять заново.
 */
export function isBusy(record: StreamRecord | undefined, nowUnix: number): boolean {
  return record !== undefined && record.status === "processing" && !isStale(record, nowUnix);
}

// --- POST /api/streams: ручное добавление записи (FR-004) ---

const vodIdFromUrl = (input: string): string => {
  const match = input.match(/videos\/(\d+)/);
  return match?.[1] ?? input;
};

const addStreamSchema = z.union([
  z.object({ url: z.string().min(1) }),
  z.object({ vodId: z.string().regex(/^\d+$/) }),
]);

export async function handleAddStream(
  request: Request,
  env: Env,
  services: Services,
  callbackBaseUrl: string,
): Promise<Response> {
  requireAdminToken(request, env);

  const body = await parseJson(request);
  const parsed = addStreamSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("invalid_input", "Укажите { url } или { vodId }.");
  }
  const vodId = "url" in parsed.data ? vodIdFromUrl(parsed.data.url) : parsed.data.vodId;
  if (!/^\d+$/.test(vodId)) {
    throw new AppError("invalid_input", "Не удалось определить идентификатор записи из адреса.");
  }

  // Пока эфир не делится, запись эфира и запись реестра — одно и то же.
  const streamId = vodId;
  const existing = await services.registry.getStream(streamId);
  if (existing !== undefined && existing.status === "ready") {
    throw new AppError("already_processed", "Эта запись уже разобрана.");
  }
  // Повторное добавление той же записи — не ошибка: она уже в работе.
  if (isBusy(existing, Math.floor(Date.now() / 1000))) {
    return Response.json({ streamId, vodId, status: "processing" }, { status: 202 });
  }

  return respondToIngest(streamId, await startStreamIngest(streamId, "manual", services, callbackBaseUrl));
}

/**
 * Чем закончился запуск разбора.
 *
 * Разбор идёт не всегда: запись, которую разбирать нечего, помечается
 * пропущенной с причиной, и вызывающий обязан узнать об этом — иначе он
 * ответит владельцу, что работа начата, тогда как её не будет.
 */
export type IngestOutcome = { status: "processing" } | { status: "skipped"; reason: string };

/**
 * Ответ на запуск разбора по его исходу.
 *
 * Код ответа, а не только поле `status`, отличает начатую работу от пропуска:
 * клиент, не читающий тело, иначе счёл бы пропуск начатым разбором. Ошибкой
 * пропуск не объявляется — владелец сделал всё правильно, а запись просто не
 * подлежит разбору.
 */
function respondToIngest(streamId: string, outcome: IngestOutcome): Response {
  const { vodId } = parseStreamId(streamId);
  if (outcome.status === "skipped") {
    return Response.json({ streamId, vodId, status: "skipped", reason: outcome.reason }, { status: 200 });
  }
  return Response.json({ streamId, vodId, status: "processing" }, { status: 202 });
}

/**
 * Общий путь запуска разбора — из ручного добавления и из расписания.
 * Расхождение между ними было бы источником неучтённых дублей.
 */
export async function startStreamIngest(
  streamId: string,
  source: "auto" | "manual",
  services: Services,
  callbackBaseUrl: string,
  previousAttempts = 0,
): Promise<IngestOutcome> {
  // Последняя защита перед запуском: она не зависит от того, кто позвал —
  // расписание, ручное добавление или путь, которого ещё нет. Раньше проверка
  // стояла только у вызывающих, и однажды разбор одной записи пошёл двумя
  // копиями сразу: два конвейера качали эфир в одну папку и затирали друг
  // другу куски, а журнал второй копии стёр след первой.
  const { vodId } = parseStreamId(streamId);
  const current = await services.registry.getStream(streamId);
  if (isBusy(current, Math.floor(Date.now() / 1000))) {
    throw new AppError("busy", "Эта запись уже разбирается.", {
      hint: "Дождитесь окончания разбора — второй запуск испортил бы работу первому.",
    });
  }

  const video = await services.twitch.getVideo(vodId);
  const reason = skipReason(video);
  if (reason !== undefined) {
    await services.registry.putStream(skippedStreamRecord(video, source, reason));
    return { status: "skipped", reason };
  }

  // Занятие записи — вплотную к запуску и одним действием хранилища:
  // проверка выше читает запись отдельно от записи, и в это окно второй запуск
  // успевает проскочить. Здесь проскочить некуда. Стоит оно после опроса
  // площадки нарочно: откажись площадка отвечать, запись осталась бы занятой
  // до истечения суток, а разбора бы не было.
  const claimed = await services.registry.claimForIngest(streamId, Math.floor(Date.now() / 1000));
  if (!claimed) {
    throw new AppError("busy", "Эта запись уже разбирается.", {
      hint: "Дождитесь окончания разбора — второй запуск испортил бы работу первому.",
    });
  }

  await services.registry.putStream({
    streamId,
    vodId,
    status: "processing",
    title: video.title,
    url: video.url,
    publishedAt: video.publishedAt,
    publishedAtUnix: video.publishedAtUnix,
    durationSeconds: video.durationSeconds,
    categories: [],
    source,
    attempts: previousAttempts + 1,
    processedAt: Math.floor(Date.now() / 1000),
  });

  try {
    await services.box.startIngest({
      streamId,
      url: video.url,
      callbackUrl: `${callbackBaseUrl}/api/internal/ingest-ready`,
      fromSeconds: 0,
      toSeconds: video.durationSeconds,
    });
  } catch (error) {
    // Бокс не принял работу — разбора не будет, и держать запись в
    // `processing` нельзя: сутки она выглядела бы разбираемой, и ни
    // владелец, ни расписание не могли бы её тронуть.
    // Причина — в журнал, а не в реестр: реестр читается публичным токеном,
    // и текст ошибки увидел бы любой посетитель страницы.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[разбор ${streamId}] запуск не удался: ${message}`);
    await services.registry.patchStream(streamId, {
      status: "failed",
      reason: "Разбор не запустился. Запись попробуют разобрать заново.",
      processedAt: Math.floor(Date.now() / 1000),
    });
    throw error;
  }

  return { status: "processing" };
}

// --- GET /api/streams/:streamId/document (FR-031) ---

export async function handleGetDocument(streamId: string, services: Services): Promise<Response> {
  // Форма идентификатора проверяется до обращения к любому хранилищу.
  const text = await services.documents.read(requireStreamId(streamId));
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Долгого кэширования здесь быть не может: повторный разбор заменяет
      // документ по тому же адресу, и прежний `immutable` оставлял бы у
      // читателя старый текст навсегда.
      "cache-control": "no-cache",
    },
  });
}

// --- DELETE /api/streams/:streamId (FR-033) ---

export async function handleDeleteStream(
  streamId: string,
  request: Request,
  env: Env,
  services: Services,
): Promise<Response> {
  requireAdminToken(request, env);
  // Удаление сносит векторы по префиксу: строка не по образцу до хранилищ не доходит.
  const { vodId } = parseStreamId(streamId);

  // Пока разбор идёт, удалять нельзя: инстанс Workflow не связан с этим
  // запросом и продолжит писать — вернёт векторы, документ и запись реестра,
  // то есть удаление будет молча отменено. А поскольку запись исчезнет из
  // индекса, следующий запуск по тому же адресу сочтёт её новой и поднимет
  // второй разбор; два разбора делят эфир по-своему и стирают разделы друг
  // друга. Занятая запись отвергается, пока не закончит или не устареет.
  const existing = await services.registry.getStream(streamId);
  if (existing?.status === "processing" && !isStale(existing, Math.floor(Date.now() / 1000))) {
    throw new AppError("busy", "Эту запись сейчас разбирают — удалить её нельзя.");
  }

  const deletedChunks = await services.knowledge.removeStream(streamId);
  await services.documents.remove(streamId).catch(() => undefined);
  await services.registry.removeStream(streamId);

  return Response.json({ streamId, vodId, deletedChunks });
}

// --- POST /api/streams/:streamId/reparse: повторный разбор (FR-028) ---

/**
 * Сколько попыток зачитывается запуску повторного разбора.
 *
 * Повтор — явное действие владельца, а не автоматики (FR-029): если он не
 * удался, автоповтор не нужен, владелец запустит сам. Исчерпанные попытки
 * ставят на этом точку, и при неудаче запись уходит в пропущенные с
 * причиной, а прежние знания и документ остаются на месте (FR-032).
 */
const REPARSE_ATTEMPTS = MAX_ATTEMPTS - 1;

/**
 * Разбор известной трансляции заново.
 *
 * Отличается от добавления записи тем, что трансляция уже в реестре: запрет
 * на повторную обработку действует для автоматики, а владелец снимает его
 * этим действием. Работа и затраты те же, что у первого разбора, — запись
 * скачивается и распознаётся заново (FR-035), — и идёт она по правилам и
 * сведениям о стримере, действующим на момент запуска (FR-033).
 */
export async function handleReparseStream(
  streamId: string,
  request: Request,
  env: Env,
  services: Services,
  callbackBaseUrl: string,
): Promise<Response> {
  requireAdminToken(request, env);
  parseStreamId(streamId);

  const existing = await services.registry.getStream(streamId);
  if (existing === undefined) {
    throw new AppError("not_found", "Такой трансляции в реестре нет.");
  }
  // Проверка стоит и здесь, и в самом запуске: здесь — чтобы владелец получил
  // понятный отказ, там — чтобы её не обошёл никакой другой путь (FR-030).
  if (isBusy(existing, Math.floor(Date.now() / 1000))) {
    throw new AppError("reparse_running", "Разбор этой трансляции уже идёт.");
  }

  // Исход тот же, что у добавления: повторный разбор идёт тем же путём, и для
  // записи, которую разбирать нечего, ответ «разбор начат» был бы неправдой.
  const outcome = await startStreamIngest(streamId, existing.source, services, callbackBaseUrl, REPARSE_ATTEMPTS);
  return respondToIngest(streamId, outcome);
}
