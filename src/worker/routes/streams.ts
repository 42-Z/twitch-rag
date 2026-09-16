/**
 * Операции владельца: ручное добавление, документ трансляции, удаление,
 * настройка канала. Разбор новых записей запускается отсюда же, что и из
 * расписания (`schedule.ts`) — общий код в `startStreamIngest`.
 */

import { z } from "zod";
import { AppError } from "../../shared/errors.ts";
import { isStale } from "../../shared/registry.ts";
import { skipReason } from "../../shared/twitch.ts";
import type { Env, Services } from "../env.ts";

export function requireAdminToken(request: Request, env: Env): void {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token === "" || token !== env.APP_ADMIN_TOKEN) {
    // Неверный токен — отказ в доступе, а не ошибка в запросе: страница
    // владельца различает эти случаи и говорит человеку, что токен не подошёл.
    throw new AppError("unauthorized", "Нужен токен владельца в заголовке Authorization.", {
      hint: "Authorization: Bearer <APP_ADMIN_TOKEN>",
    });
  }
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

  const existing = await services.registry.getStream(vodId);
  if (existing !== undefined && existing.status === "ready") {
    throw new AppError("already_processed", "Эта запись уже разобрана.");
  }
  if (existing !== undefined && existing.status === "processing") {
    return Response.json({ vodId, status: "processing" }, { status: 202 });
  }

  await startStreamIngest(vodId, "manual", services, callbackBaseUrl);
  return Response.json({ vodId, status: "processing" }, { status: 202 });
}

/**
 * Общий путь запуска разбора — из ручного добавления и из расписания.
 * Расхождение между ними было бы источником неучтённых дублей.
 */
export async function startStreamIngest(
  vodId: string,
  source: "auto" | "manual",
  services: Services,
  callbackBaseUrl: string,
  previousAttempts = 0,
): Promise<void> {
  const video = await services.twitch.getVideo(vodId);
  const reason = skipReason(video);
  if (reason !== undefined) {
    await services.registry.putStream({
      vodId,
      status: "skipped",
      title: video.title,
      url: video.url,
      publishedAt: video.publishedAt,
      publishedAtUnix: video.publishedAtUnix,
      durationSeconds: video.durationSeconds,
      categories: [],
      source,
      reason,
      attempts: 0,
    });
    return;
  }

  await services.registry.putStream({
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
      vodId,
      url: video.url,
      callbackUrl: `${callbackBaseUrl}/api/internal/ingest-ready`,
    });
  } catch (error) {
    // Бокс не принял работу — разбора не будет, и держать запись в
    // `processing` нельзя: сутки она выглядела бы разбираемой, и ни
    // владелец, ни расписание не могли бы её тронуть.
    const message = error instanceof Error ? error.message : String(error);
    await services.registry.patchStream(vodId, {
      status: "failed",
      reason: `Разбор не запустился: ${message}`,
      processedAt: Math.floor(Date.now() / 1000),
    });
    throw error;
  }
}

// --- GET /api/streams/:vodId/document (FR-031) ---

export async function handleGetDocument(vodId: string, services: Services): Promise<Response> {
  const text = await services.documents.read(vodId);
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Документ неизменен после создания — кэшировать безопасно и долго.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

// --- DELETE /api/streams/:vodId (FR-033) ---

export async function handleDeleteStream(
  vodId: string,
  request: Request,
  env: Env,
  services: Services,
): Promise<Response> {
  requireAdminToken(request, env);

  // Пока разбор идёт, удалять нельзя: инстанс Workflow не связан с этим
  // запросом и продолжит писать — вернёт векторы, документ и запись реестра,
  // то есть удаление будет молча отменено. А поскольку запись исчезнет из
  // индекса, следующий запуск по тому же адресу сочтёт её новой и поднимет
  // второй разбор; два разбора делят эфир по-своему и стирают разделы друг
  // друга. Занятая запись отвергается, пока не закончит или не устареет.
  const existing = await services.registry.getStream(vodId);
  if (existing?.status === "processing" && !isStale(existing, Math.floor(Date.now() / 1000))) {
    throw new AppError("busy", "Эту запись сейчас разбирают — удалить её нельзя.");
  }

  const deletedChunks = await services.knowledge.removeStream(vodId);
  await services.documents.remove(vodId).catch(() => undefined);
  await services.registry.removeStream(vodId);

  return Response.json({ vodId, deletedChunks });
}

// --- PUT /api/channel: настройка отслеживаемого канала (US2) ---

const channelSchema = z.object({ login: z.string().trim().min(1).max(50) });

export async function handleSetChannel(request: Request, env: Env, services: Services): Promise<Response> {
  requireAdminToken(request, env);

  const body = await parseJson(request);
  const parsed = channelSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("invalid_input", "Укажите { login } — логин канала на Twitch.");
  }

  const channel = await services.twitch.getChannelByLogin(parsed.data.login);
  const now = Math.floor(Date.now() / 1000);
  await services.registry.setChannel({
    twitchUserId: channel.id,
    login: channel.login,
    displayName: channel.displayName,
    watchFrom: now,
    addedAt: now,
  });

  return Response.json({ login: channel.login, displayName: channel.displayName, watchFrom: now });
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("invalid_input", "Тело запроса должно быть объектом JSON.");
  }
}
