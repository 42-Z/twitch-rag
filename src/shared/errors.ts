/**
 * Ошибки, которые видит человек или программный клиент.
 *
 * Правило: техническая причина уходит в лог, пользователю достаётся текст,
 * из которого понятно, что произошло и что делать дальше.
 */

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "vod_unavailable"
  | "channel_not_set"
  | "already_processed"
  | "unauthorized"
  | "busy"
  | "upstream_unavailable"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  vod_unavailable: 404,
  channel_not_set: 409,
  already_processed: 409,
  unauthorized: 401,
  busy: 409,
  upstream_unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

/** Подсказка по умолчанию: что делать, если наткнулся на эту ошибку. */
const HINT: Partial<Record<ErrorCode, string>> = {
  invalid_input: "Проверьте поля запроса и повторите.",
  not_found: "Проверьте адрес: такого ресурса нет.",
  vod_unavailable: "Проверьте ссылку или добавьте другую запись.",
  channel_not_set: "Укажите отслеживаемый канал на странице сервиса.",
  already_processed: "Эта запись уже разобрана — её знания уже доступны.",
  unauthorized: "Неверный токен владельца.",
  busy: "Эту запись сейчас разбирают. Дождитесь окончания разбора.",
  upstream_unavailable: "Внешний сервис недоступен. Попробуйте позже.",
  rate_limited: "Слишком много запросов. Подождите и повторите.",
  internal: "Если повторяется — загляните в журнал Worker.",
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; hint?: string };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.hint = options?.hint ?? HINT[code];
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint === undefined ? {} : { hint: this.hint }),
      },
    };
  }
}

/**
 * Ошибка внешнего сервиса: причина сохраняется в `cause`, наружу уходит
 * понятный текст. Причина ещё и пишется в журнал: внутри шага Workflow
 * наружу видно только текст ошибки, и без этой записи отказ внешнего
 * сервиса неотличим от любого другого — разбирать нечего.
 */
export function upstreamError(service: string, cause: unknown): AppError {
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error(`[${service}] ${reason}`);
  return new AppError("upstream_unavailable", `Сервис «${service}» сейчас недоступен.`, { cause });
}

/**
 * Любое исключение приводится к ответу контракта. Неизвестная ошибка
 * становится `internal`: наружу не просачиваются ни трассировки, ни адреса.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("internal", "Внутренняя ошибка сервиса.", { cause: error });
}

export function errorResponse(error: unknown, extraHeaders?: Record<string, string>): Response {
  const appError = toAppError(error);
  return Response.json(appError.toBody(), {
    status: appError.status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
