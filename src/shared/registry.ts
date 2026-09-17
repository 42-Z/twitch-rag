/**
 * Реестр: что разобрано, что пропущено и какой канал отслеживается.
 *
 * Реестр читают двое — Worker полным токеном и страница интерфейса токеном
 * только на чтение, прямо из браузера. Поэтому здесь не должно быть ничего,
 * что нельзя показать посетителю страницы.
 */

import { Redis } from "@upstash/redis";
import type { Chapter } from "./categories.ts";
import { upstreamError } from "./errors.ts";

export type StreamStatus = "processing" | "ready" | "skipped" | "failed";

export interface ChannelRecord {
  twitchUserId: string;
  login: string;
  displayName: string;
  /** Момент подключения: записи старше не берутся автоматически. */
  watchFrom: number;
  addedAt: number;
  lastCheckedAt?: number;
  lastCheckError?: string;
  /**
   * Сведения о стримере: кто это, о чём канал, кто постоянные собеседники,
   * свои словечки. Свободный текст от владельца, уходит в системную
   * инструкцию. Пустая строка и отсутствие поля равнозначны «не заполнено».
   */
  streamerInfo?: string;
}

export interface StreamRecord {
  vodId: string;
  status: StreamStatus;
  /**
   * Заголовок с площадки. Служебное поле: в разборе не участвует и нигде не
   * показывается (FR-027), остаётся только чтобы опознать запись, у которой
   * документа ещё нет.
   */
  title: string;
  /**
   * Имя документа, выработанное по содержанию эфира. Заполняется вместе с
   * разбором; у разобранной записи оно есть всегда (FR-022).
   */
  docTitle?: string;
  url: string;
  publishedAt: string;
  publishedAtUnix: number;
  durationSeconds: number;
  language?: string;
  categories: Chapter[];
  sectionCount?: number;
  chunkCount?: number;
  speechSeconds?: number;
  docPath?: string;
  source: "auto" | "manual";
  reason?: string;
  attempts: number;
  costUsd?: number;
  processedAt?: number;
}

/** Больше трёх неудач подряд — запись уходит в пропущенные, а не крутится вечно. */
export const MAX_ATTEMPTS = 3;
/** Разбор длится минуты; запись в `processing` дольше суток считается брошенной. */
export const STALE_PROCESSING_SECONDS = 24 * 60 * 60;

const CHANNEL_KEY = "channel";
const INDEX_KEY = "streams:index";
const TOKEN_KEY = "twitch:token";

const streamKey = (vodId: string) => `stream:${vodId}`;

export interface RegistryConfig {
  url: string;
  token: string;
}

export class Registry {
  private readonly redis: Redis;

  constructor(config: RegistryConfig) {
    this.redis = new Redis({ url: config.url, token: config.token });
  }

  // --- канал ---

  async getChannel(): Promise<ChannelRecord | undefined> {
    const raw = await this.call(() => this.redis.hgetall<Record<string, unknown>>(CHANNEL_KEY));
    if (raw === null || Object.keys(raw).length === 0) return undefined;
    // Сведения о стримере живут в том же хеше и могут появиться раньше самого
    // канала. Хеш без логина — это не подключённый канал, и опрос по нему
    // уходил бы в площадку с пустым идентификатором.
    if (asString(raw["login"]) === "") return undefined;
    return {
      twitchUserId: asString(raw["twitchUserId"]),
      login: asString(raw["login"]),
      displayName: asString(raw["displayName"]),
      watchFrom: asNumber(raw["watchFrom"]),
      addedAt: asNumber(raw["addedAt"]),
      ...(raw["lastCheckedAt"] === undefined ? {} : { lastCheckedAt: asNumber(raw["lastCheckedAt"]) }),
      ...(raw["lastCheckError"] === undefined ? {} : { lastCheckError: asString(raw["lastCheckError"]) }),
      ...(raw["streamerInfo"] === undefined ? {} : { streamerInfo: asString(raw["streamerInfo"]) }),
    };
  }

  /**
   * Поля перечислены поимённо, а не разложены из записи: сведения о стримере
   * правятся отдельным действием, и подключение канала не должно их затирать.
   */
  async setChannel(channel: ChannelRecord): Promise<void> {
    await this.call(() =>
      this.redis.hset(CHANNEL_KEY, {
        twitchUserId: channel.twitchUserId,
        login: channel.login,
        displayName: channel.displayName,
        watchFrom: channel.watchFrom,
        addedAt: channel.addedAt,
      }),
    );
  }

  /**
   * Сведения о стримере (FR-014). Пустая строка сохраняется как есть: это
   * осознанное «сведений нет», а не отсутствие записи (FR-016).
   */
  async setStreamerInfo(info: string): Promise<void> {
    await this.call(() => this.redis.hset(CHANNEL_KEY, { streamerInfo: info }));
  }

  /** Итог очередного опроса канала: отсутствие новых записей — не ошибка. */
  async recordCheck(result: { at: number; error?: string }): Promise<void> {
    await this.call(() =>
      this.redis.hset(CHANNEL_KEY, {
        lastCheckedAt: result.at,
        lastCheckError: result.error ?? "",
      }),
    );
  }

  // --- трансляции ---

  async getStream(vodId: string): Promise<StreamRecord | undefined> {
    const raw = await this.call(() => this.redis.hgetall<Record<string, unknown>>(streamKey(vodId)));
    if (raw === null || Object.keys(raw).length === 0) return undefined;
    return toStreamRecord(raw);
  }

  /**
   * Запись реестра и её место в списке по дате меняются вместе: список,
   * разошедшийся с записями, ломает и страницу, и выбор «что разбирать».
   */
  async putStream(record: StreamRecord): Promise<void> {
    const stored: Record<string, string | number> = {
      vodId: record.vodId,
      status: record.status,
      title: record.title,
      url: record.url,
      publishedAt: record.publishedAt,
      publishedAtUnix: record.publishedAtUnix,
      durationSeconds: record.durationSeconds,
      categories: JSON.stringify(record.categories),
      source: record.source,
      attempts: record.attempts,
    };
    for (const [key, value] of Object.entries({
      docTitle: record.docTitle,
      language: record.language,
      sectionCount: record.sectionCount,
      chunkCount: record.chunkCount,
      speechSeconds: record.speechSeconds,
      docPath: record.docPath,
      reason: record.reason,
      costUsd: record.costUsd,
      processedAt: record.processedAt,
    })) {
      if (value !== undefined) stored[key] = value as string | number;
    }

    await this.call(async () => {
      const transaction = this.redis.multi();
      transaction.hset(streamKey(record.vodId), stored);
      transaction.zadd(INDEX_KEY, { score: record.publishedAtUnix, member: record.vodId });
      await transaction.exec();
    });
  }

  async patchStream(vodId: string, patch: Partial<StreamRecord>): Promise<void> {
    const stored: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stored[key] = key === "categories" ? JSON.stringify(value) : (value as string | number);
    }
    if (Object.keys(stored).length === 0) return;
    await this.call(() => this.redis.hset(streamKey(vodId), stored));
  }

  async removeStream(vodId: string): Promise<void> {
    await this.call(async () => {
      const transaction = this.redis.multi();
      transaction.del(streamKey(vodId));
      transaction.zrem(INDEX_KEY, vodId);
      await transaction.exec();
    });
  }

  /** Идентификаторы всех известных записей — основа проверки «эту уже брали». */
  async knownVodIds(): Promise<string[]> {
    const ids = await this.call(() => this.redis.zrange<string[]>(INDEX_KEY, 0, -1));
    return ids;
  }

  async listStreams(options: { limit?: number; fromUnix?: number; toUnix?: number } = {}): Promise<StreamRecord[]> {
    const min = options.fromUnix ?? 0;
    const max = options.toUnix ?? Number.MAX_SAFE_INTEGER;
    const ids = await this.call(() =>
      this.redis.zrange<string[]>(INDEX_KEY, max, min, { byScore: true, rev: true }),
    );
    const selected = options.limit === undefined ? ids : ids.slice(0, options.limit);

    const records: StreamRecord[] = [];
    for (const id of selected) {
      const record = await this.getStream(id);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  // --- токен площадки ---

  /** Пустое значение читается как отсутствие: сброс кэша не должен оставлять пустышку. */
  async getCachedTwitchToken(): Promise<string | undefined> {
    const token = await this.call(() => this.redis.get<string>(TOKEN_KEY));
    return token === null || token === "" ? undefined : token;
  }

  async cacheTwitchToken(token: string, expiresInSeconds: number): Promise<void> {
    // Запас в минуту: токен не должен протухнуть между проверкой и запросом.
    const ttl = Math.max(60, Math.floor(expiresInSeconds) - 60);
    await this.call(() => this.redis.set(TOKEN_KEY, token, { ex: ttl }));
  }

  /**
   * Сброс кэша токена при отказе авторизации. Именно удаление: запись пустой
   * строки оставляла бы ключ живым, а пустой токен — пригодным к употреблению,
   * и повтор уходил бы с заголовком `Bearer ` до истечения срока.
   */
  async forgetTwitchToken(): Promise<void> {
    await this.call(() => this.redis.del(TOKEN_KEY));
  }

  async healthy(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Кэш дорогих ответов. Ошибка хранилища не поднимается: кэш — ускорение,
   * а не источник истины, и его недоступность не должна ломать сам ответ.
   */
  async readCache<T>(key: string): Promise<T | undefined> {
    try {
      return (await this.redis.get<T>(key)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, { ex: ttlSeconds });
    } catch {
      // Промах кэша стоит одного пересчёта — это не повод падать.
    }
  }

  private async call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw upstreamError("реестр", error);
    }
  }
}

/**
 * Клиент Upstash сам разбирает значения, похожие на JSON, поэтому поле
 * `categories` возвращается то строкой, то уже массивом. Обрабатываются оба
 * случая: догадка о поведении клиента здесь стоила бы падения на живых данных.
 */
function asChapters(value: unknown): Chapter[] {
  if (Array.isArray(value)) return value as Chapter[];
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Chapter[]) : [];
  } catch {
    return [];
  }
}

function asString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text === "" ? undefined : text;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStreamRecord(raw: Record<string, unknown>): StreamRecord {
  const status = asString(raw["status"]);
  return {
    vodId: asString(raw["vodId"]),
    status: isStatus(status) ? status : "failed",
    title: asString(raw["title"]),
    url: asString(raw["url"]),
    publishedAt: asString(raw["publishedAt"]),
    publishedAtUnix: asNumber(raw["publishedAtUnix"]),
    durationSeconds: asNumber(raw["durationSeconds"]),
    categories: asChapters(raw["categories"]),
    source: asString(raw["source"]) === "manual" ? "manual" : "auto",
    attempts: asNumber(raw["attempts"]),
    ...defined("docTitle", optionalString(raw["docTitle"])),
    ...defined("language", optionalString(raw["language"])),
    ...defined("sectionCount", optionalNumber(raw["sectionCount"])),
    ...defined("chunkCount", optionalNumber(raw["chunkCount"])),
    ...defined("speechSeconds", optionalNumber(raw["speechSeconds"])),
    ...defined("docPath", optionalString(raw["docPath"])),
    ...defined("reason", optionalString(raw["reason"])),
    ...defined("costUsd", optionalNumber(raw["costUsd"])),
    ...defined("processedAt", optionalNumber(raw["processedAt"])),
  };
}

function defined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function isStatus(value: string): value is StreamStatus {
  return value === "processing" || value === "ready" || value === "skipped" || value === "failed";
}

/** Брошенный разбор: живёт в `processing` дольше суток и должен быть взят заново. */
export function isStale(record: StreamRecord, nowUnix: number): boolean {
  if (record.status !== "processing") return false;
  const startedAt = record.processedAt ?? record.publishedAtUnix;
  return nowUnix - startedAt > STALE_PROCESSING_SECONDS;
}
