/**
 * Чтение реестра прямо из браузера read-only токеном, минуя Worker.
 *
 * Список трансляций не тратит вызовы Worker: страница читает Upstash Redis
 * напрямую. Токен разрешает только чтение — документация хранилища прямо
 * допускает его раскрытие в веб-клиентах.
 *
 * Здесь голый REST, а не клиент хранилища, и это важная разница: `HGETALL`
 * отвечает плоским списком «поле, значение, поле, значение», и все значения
 * приходят строками как есть. Разбор значений, похожих на JSON (числа,
 * `true`, `null`) — это поведение клиента, а он остаётся на стороне Worker.
 * Поэтому числа здесь приводятся через `Number`, а поля читаются по одному.
 */

const REGISTRY_URL = process.env.BUN_PUBLIC_REGISTRY_URL ?? "";
const READONLY_TOKEN = process.env.BUN_PUBLIC_REGISTRY_READONLY_TOKEN ?? "";

export interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

export interface StreamSummary {
  vodId: string;
  status: "processing" | "ready" | "skipped" | "failed";
  /** Заголовок с площадки: служебное поле, показывается только у неразобранного. */
  title: string;
  /** Имя документа, выработанное по содержанию эфира (FR-025). */
  docTitle?: string;
  url: string;
  publishedAt: string;
  durationSeconds: number;
  categories: Chapter[];
  sectionCount: number;
  reason?: string;
}

export interface ChannelSummary {
  login: string;
  displayName: string;
  lastCheckedAt?: number;
  lastCheckError?: string;
  /** Сведения о стримере: заполняет владелец, уходят в системную инструкцию. */
  streamerInfo?: string;
}

class RegistryUnavailableError extends Error {}

async function redisCall<T>(command: readonly unknown[]): Promise<T> {
  if (REGISTRY_URL === "" || READONLY_TOKEN === "") {
    throw new RegistryUnavailableError("Адрес реестра не настроен в сборке интерфейса.");
  }
  const response = await fetch(REGISTRY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${READONLY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new RegistryUnavailableError(`Реестр ответил ${response.status}.`);
  }
  const body = (await response.json()) as { result: T; error?: string };
  if (body.error !== undefined) throw new RegistryUnavailableError(body.error);
  return body.result;
}

/** Несколько команд за один запрос — отдельный путь `/pipeline`, а не POST на базовый адрес. */
async function redisPipeline<T>(commands: readonly (readonly unknown[])[]): Promise<T[]> {
  if (commands.length === 0) return [];
  if (REGISTRY_URL === "" || READONLY_TOKEN === "") {
    throw new RegistryUnavailableError("Адрес реестра не настроен в сборке интерфейса.");
  }
  const response = await fetch(`${REGISTRY_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${READONLY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!response.ok) {
    throw new RegistryUnavailableError(`Реестр ответил ${response.status}.`);
  }
  const body = (await response.json()) as Array<{ result: T; error?: string }>;
  return body.map((entry) => entry.result);
}

function toChapters(value: unknown): Chapter[] {
  if (Array.isArray(value)) return value as Chapter[];
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Chapter[]) : [];
  } catch {
    return [];
  }
}

/**
 * Плоский ответ `HGETALL` в пары «поле — значение».
 *
 * Вынесено отдельно, потому что так читается и запись трансляции, и запись
 * канала, и формат этот — часть контракта хранилища, а не мелочь: ответ
 * приходит списком, где поле и значение чередуются.
 */
export function fieldsToMap(fields: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key !== undefined && value !== undefined) map.set(key, value);
  }
  return map;
}

export function toSummary(fields: string[]): StreamSummary | undefined {
  const map = fieldsToMap(fields);
  const vodId = map.get("vodId");
  if (vodId === undefined) return undefined;

  const status = map.get("status") ?? "failed";
  return {
    vodId,
    status: status === "processing" || status === "ready" || status === "skipped" || status === "failed"
      ? status
      : "failed",
    title: map.get("title") ?? "",
    ...(map.get("docTitle") === undefined || map.get("docTitle") === "" ? {} : { docTitle: map.get("docTitle") }),
    url: map.get("url") ?? "",
    publishedAt: map.get("publishedAt") ?? "",
    durationSeconds: Number(map.get("durationSeconds") ?? 0),
    categories: toChapters(map.get("categories")),
    sectionCount: Number(map.get("sectionCount") ?? 0),
    ...(map.get("reason") === undefined || map.get("reason") === "" ? {} : { reason: map.get("reason") }),
  };
}

/** Все известные трансляции, свежие первыми, разобранные и пропущенные вместе. */
export async function listStreams(): Promise<StreamSummary[]> {
  const ids = await redisCall<string[]>(["ZRANGE", "streams:index", "0", "-1", "REV"]);
  if (ids.length === 0) return [];

  const results = await redisPipeline<string[]>(ids.map((id) => ["HGETALL", `stream:${id}`]));

  return results.map(toSummary).filter((summary): summary is StreamSummary => summary !== undefined);
}

export async function getChannel(): Promise<ChannelSummary | undefined> {
  const fields = await redisCall<string[]>(["HGETALL", "channel"]);
  if (fields.length === 0) return undefined;
  const map = fieldsToMap(fields);
  const login = map.get("login");
  if (login === undefined || login === "") return undefined;
  return {
    login,
    displayName: map.get("displayName") ?? login,
    ...(map.get("lastCheckedAt") === undefined ? {} : { lastCheckedAt: Number(map.get("lastCheckedAt")) }),
    ...(map.get("lastCheckError") === undefined || map.get("lastCheckError") === ""
      ? {}
      : { lastCheckError: map.get("lastCheckError") }),
    ...(map.get("streamerInfo") === undefined ? {} : { streamerInfo: map.get("streamerInfo") }),
  };
}
