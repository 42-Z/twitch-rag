/**
 * Служебные вызовы от бокса.
 *
 * Единственный клиент — прогон в боксе, аутентифицированный общим секретом,
 * а не токеном владельца: это внутренняя связь между двумя частями одного
 * сервиса, а не операция человека.
 */

import { AppError } from "../../shared/errors.ts";
import type { Env, IngestParams } from "../env.ts";
import { createServices } from "../env.ts";

export interface IngestReadyBody {
  vodId: string;
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

/**
 * Сигнал о готовности кусков либо об отказе бокса.
 *
 * Повторный вызов для записи, уже находящейся в обработке, отвечает 200 без
 * создания нового инстанса — бокс мог повторить сигнал после сбоя сети.
 */
export async function handleIngestReady(request: Request, env: Env): Promise<Response> {
  requireIngestSecret(request, env);

  const body = await parseBody(request);
  const services = createServices(env);

  if (isFailure(body)) {
    await services.registry.patchStream(body.vodId, {
      status: "skipped",
      reason: body.message,
      processedAt: nowUnix(),
    });
    return Response.json({ vodId: body.vodId, status: "skipped" });
  }

  const payload = body as IngestReadyBody;
  if (payload.vodId === undefined || payload.vodId === "") {
    throw new AppError("invalid_input", "В сигнале прогона нет vodId.");
  }

  const existing = await services.registry.getStream(payload.vodId);
  if (existing !== undefined && existing.status === "processing") {
    // Уже запущено — вероятный повтор сигнала после сетевого сбоя у бокса.
    return Response.json({ vodId: payload.vodId, status: "processing" });
  }

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
    attempts: (existing?.attempts ?? 0) + 1,
    processedAt: nowUnix(),
  });

  const params: IngestParams = {
    vodId: payload.vodId,
    title: payload.title,
    url: `https://www.twitch.tv/videos/${payload.vodId}`,
    publishedAt: payload.publishedAt,
    durationSeconds: payload.durationSeconds,
    categories: payload.categories,
    chunks: payload.chunks,
  };

  const instance = await env.INGEST.create({ id: `${payload.vodId}-${Date.now()}`, params });
  return Response.json({ vodId: payload.vodId, status: "processing", instanceId: instance.id }, { status: 202 });
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
