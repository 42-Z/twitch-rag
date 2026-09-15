/**
 * Точка входа Worker.
 *
 * Логика запускается только на `/api/*` и `/mcp` — так задано в
 * `wrangler.jsonc`. Остальное отдаёт статика, не тратя вызовы Worker: иначе
 * исчерпание суточного лимита превращало бы страницу в ошибку.
 */

import { errorResponse, AppError } from "../shared/errors.ts";
import { enforceRateLimit, rateLimitHeaders } from "./ratelimit.ts";
import type { Env } from "./env.ts";
import { createServices } from "./env.ts";
import { handleHealth } from "./routes/health.ts";
import { handleMcp } from "./mcp.ts";
import { knowledgeStats, parseSearchRequest, searchKnowledge } from "./routes/knowledge.ts";
import { handleIngestReady } from "./routes/internal.ts";
import {
  handleAddStream,
  handleDeleteStream,
  handleGetDocument,
  handleSetChannel,
} from "./routes/streams.ts";
import { runScheduledCheck } from "./schedule.ts";

export { StreamIngestWorkflow } from "./workflow.ts";

type Handler = (request: Request, env: Env, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  /** Шаблон пути; `:name` — подстановка. */
  pattern: string;
  handler: Handler;
}

/**
 * Маршруты перечислены данными, а не ветвлениями: новый путь добавляется
 * строкой таблицы и не трогает соседние.
 */
const ROUTES: Route[] = [
  { method: "GET", pattern: "/api/health", handler: (_request, env) => handleHealth(env) },

  {
    method: "POST",
    pattern: "/api/knowledge/search",
    handler: async (request, env) => {
      await enforceRateLimit(request, env, "search");
      const body = await readJson(request);
      const parsed = parseSearchRequest(body);
      const result = await searchKnowledge(parsed, createServices(env));
      return Response.json(result);
    },
  },

  {
    method: "GET",
    pattern: "/api/knowledge/stats",
    handler: async (request, env) => {
      await enforceRateLimit(request, env, "stats");
      return Response.json(await knowledgeStats(createServices(env)));
    },
  },

  {
    method: "GET",
    pattern: "/api/streams/:vodId/document",
    handler: (_request, env, params) => handleGetDocument(params.vodId ?? "", createServices(env)),
  },

  {
    method: "POST",
    pattern: "/api/streams",
    handler: (request, env) => handleAddStream(request, env, createServices(env), originOf(request)),
  },

  {
    method: "DELETE",
    pattern: "/api/streams/:vodId",
    handler: (request, env, params) =>
      handleDeleteStream(params.vodId ?? "", request, env, createServices(env)),
  },

  {
    method: "PUT",
    pattern: "/api/channel",
    handler: (request, env) => handleSetChannel(request, env, createServices(env)),
  },

  {
    method: "POST",
    pattern: "/api/internal/ingest-ready",
    handler: (request, env) => handleIngestReady(request, env),
  },
];

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("invalid_input", "Тело запроса должно быть объектом JSON.");
  }
}

/** Объекты старше суток не могут принадлежать активному разбору — он длится минуты. */
const STALE_AUDIO_SECONDS = 24 * 60 * 60;

async function cleanupStaleAudio(env: Env): Promise<void> {
  const cutoff = Date.now() - STALE_AUDIO_SECONDS * 1000;
  let cursor: string | undefined;
  do {
    const listed = await env.AUDIO.list({ prefix: "audio/", ...(cursor === undefined ? {} : { cursor }) });
    const stale = listed.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);
    if (stale.length > 0) await env.AUDIO.delete(stale);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // На расписании нет входящего запроса, откуда обычно берётся адрес —
    // он задан переменной окружения (публичный адрес сервиса, не секрет).
    ctx.waitUntil(runScheduledCheck(createServices(env), env.WORKER_URL));
    ctx.waitUntil(cleanupStaleAudio(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // MCP обслуживает собственный обработчик: у него свой разбор протокола,
    // свои коды ошибок и свои заголовки.
    if (url.pathname === "/mcp") {
      try {
        await enforceRateLimit(request, env, "mcp");
      } catch (error) {
        return withCors(errorResponse(error, rateLimitHeaders(error)));
      }
      return await handleMcp(request, env, ctx);
    }

    if (request.method === "OPTIONS") return preflightResponse();

    try {
      for (const route of ROUTES) {
        if (route.method !== request.method) continue;
        const params = matchPath(route.pattern, url.pathname);
        if (params === undefined) continue;
        const response = await route.handler(request, env, params);
        return withCors(response);
      }

      throw new AppError("not_found", "Такого пути у сервиса нет.");
    } catch (error) {
      return withCors(errorResponse(error, rateLimitHeaders(error)));
    }
  },
} satisfies ExportedHandler<Env>;

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/");
  const pathParts = pathname.replace(/\/+$/, "").split("/");
  if (patternParts.length !== pathParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) {
      if (actual === "") return undefined;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

/**
 * Знания публичны и рассчитаны на обращения из чужих страниц и клиентов,
 * поэтому доступ открыт всем источникам. Операции владельца защищает токен,
 * а не происхождение запроса.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-ingest-secret, mcp-session-id",
  "access-control-max-age": "86400",
};

function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
