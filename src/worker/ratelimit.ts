/**
 * Ограничение частоты для публичных путей.
 *
 * Знания доступны без авторизации, поэтому любой, кто узнал адрес, способен
 * исчерпать суточный лимит Worker и потратить средства владельца на
 * эмбеддинги. Ограничитель — не украшение, а условие публичности.
 *
 * Считает встроенный ограничитель Cloudflare, а не реестр: у бесплатного
 * Redis 500 тысяч команд в месяц, и защита, расходующая эту квоту на каждый
 * чужой запрос, работала бы против себя.
 */

import { AppError } from "../shared/errors.ts";
import type { Env } from "./env.ts";

/** Через сколько секунд разумно повторить попытку после отказа. */
const RETRY_AFTER_SECONDS = 60;

/** Максимальная длина вопроса: длинный запрос не должен уходить в модель. */
export const MAX_QUERY_CHARS = 1000;

export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
}

/**
 * Проверка перед обработкой публичного запроса. Отказ — исключение с кодом
 * `rate_limited`: заголовок `Retry-After` добавляется на уровне маршрутизации.
 */
export async function enforceRateLimit(request: Request, env: Env, bucket: string): Promise<void> {
  const limiter = env.PUBLIC_RATE_LIMITER;
  // Локальный запуск без привязки — не повод падать: ограничитель просто
  // отсутствует, и это видно в конфигурации, а не в поведении.
  if (limiter === undefined) return;

  const key = `${bucket}:${clientAddress(request)}`;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new AppError("rate_limited", "Слишком много запросов с этого адреса.", {
      hint: `Подождите ${RETRY_AFTER_SECONDS} секунд и повторите.`,
    });
  }
}

export function rateLimitHeaders(error: unknown): Record<string, string> {
  return error instanceof AppError && error.code === "rate_limited"
    ? { "retry-after": String(RETRY_AFTER_SECONDS) }
    : {};
}
