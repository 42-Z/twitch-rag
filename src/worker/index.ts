/**
 * Точка входа Worker.
 *
 * Логика запускается только на `/api/*` и `/mcp` — так задано в
 * `wrangler.jsonc`. Остальное отдаёт статика, не тратя вызовы Worker: иначе
 * исчерпание суточного лимита превращало бы страницу в ошибку.
 */

import { errorResponse, AppError } from "../shared/errors.ts";
import { rateLimitHeaders } from "./ratelimit.ts";
import type { Env } from "./env.ts";
import { handleHealth } from "./routes/health.ts";

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
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
