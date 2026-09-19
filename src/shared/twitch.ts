/**
 * Площадка: канал и список записей эфиров.
 *
 * Токен приложения живёт в реестре с истечением по сроку из ответа: свой
 * счётчик времени здесь был бы лишним источником расхождений.
 */

import { AppError, upstreamError } from "./errors.ts";
import { parseTwitchDuration } from "./time.ts";

const OAUTH_URL = "https://id.twitch.tv/oauth2/token";
const HELIX_URL = "https://api.twitch.tv/helix";

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
}

/** Хранилище токена: реестр умеет это, но зависимость здесь не нужна. */
export interface TokenCache {
  getCachedTwitchToken(): Promise<string | undefined>;
  cacheTwitchToken(token: string, expiresInSeconds: number): Promise<void>;
  /** Сброс при отказе авторизации: ключ удаляется, а не переписывается пустым. */
  forgetTwitchToken(): Promise<void>;
}

export interface TwitchChannel {
  id: string;
  login: string;
  displayName: string;
}

export interface TwitchVideo {
  vodId: string;
  title: string;
  url: string;
  publishedAt: string;
  publishedAtUnix: number;
  durationSeconds: number;
  /**
   * Эфир, из которого выросла запись. Нужен, чтобы отличить запись
   * законченного эфира от растущей записи идущего: площадка заводит её в
   * первые же секунды трансляции.
   */
  streamId: string;
  /** `public` — доступна всем; иное значение означает ограниченный доступ. */
  viewable: string;
  /** Участки, заглушённые правообладателем: речи там нет. */
  mutedSegments: Array<{ offsetSeconds: number; durationSeconds: number }>;
}

export class Twitch {
  constructor(
    private readonly credentials: TwitchCredentials,
    private readonly cache: TokenCache,
  ) {}

  async getChannelByLogin(login: string): Promise<TwitchChannel> {
    const data = await this.helix<{ data: Array<{ id: string; login: string; display_name: string }> }>(
      `/users?login=${encodeURIComponent(login.toLowerCase())}`,
    );
    const user = data.data[0];
    if (user === undefined) {
      throw new AppError("not_found", `Канал «${login}» на Twitch не найден.`, {
        hint: "Проверьте написание логина канала.",
      });
    }
    return { id: user.id, login: user.login, displayName: user.display_name };
  }

  /**
   * Просмотр архива страницами: за один запуск берётся одна запись к разбору,
   * поэтому окно в одну страницу пропускало бы эфиры, появившиеся за время
   * простоя. Просмотр останавливается на первой известной записи — в обычной
   * работе это первая же страница, — и не длится дольше `maxPages`.
   */
  async listArchive(
    userId: string,
    options: { pageSize: number; maxPages: number; stopAt: (video: TwitchVideo) => boolean },
  ): Promise<TwitchVideo[]> {
    const collected: TwitchVideo[] = [];
    let after: string | undefined;

    for (let page = 0; page < options.maxPages; page++) {
      const cursor = after === undefined ? "" : `&after=${encodeURIComponent(after)}`;
      const data = await this.helix<{ data: RawVideo[]; pagination?: { cursor?: string } }>(
        `/videos?user_id=${encodeURIComponent(userId)}&type=archive&first=${Math.min(options.pageSize, 100)}${cursor}`,
      );

      const batch = data.data.map(toVideo);
      collected.push(...batch);
      if (batch.length === 0 || batch.some(options.stopAt)) break;

      after = data.pagination?.cursor;
      if (after === undefined || after === "") break;
    }

    return collected;
  }

  /**
   * Идентификатор идущего эфира канала либо `undefined`, если канал не в эфире.
   *
   * Площадка заводит запись архива сразу, как только начинается трансляция, и
   * она растёт до конца эфира. По этому идентификатору такая запись отличается
   * от записи законченного эфира: у той `streamId` указывает на прошлый эфир.
   */
  async getLiveStreamId(userId: string): Promise<string | undefined> {
    const data = await this.helix<{ data: Array<{ id: string }> }>(
      `/streams?user_id=${encodeURIComponent(userId)}`,
    );
    return data.data[0]?.id;
  }

  async getVideo(vodId: string): Promise<TwitchVideo> {
    const data = await this.helix<{ data: RawVideo[] }>(`/videos?id=${encodeURIComponent(vodId)}`);
    const video = data.data[0];
    if (video === undefined) {
      throw new AppError("vod_unavailable", "Запись недоступна: она удалена или закрыта.");
    }
    return toVideo(video);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch {
      return false;
    }
  }

  private async token(): Promise<string> {
    const cached = await this.cache.getCachedTwitchToken();
    if (cached !== undefined) return cached;

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: "client_credentials",
    });

    let response: Response;
    try {
      response = await fetch(OAUTH_URL, { method: "POST", body });
    } catch (error) {
      throw upstreamError("Twitch", error);
    }
    if (!response.ok) {
      throw new AppError("upstream_unavailable", "Twitch не выдал токен приложения.", {
        hint: "Проверьте TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET.",
      });
    }

    const payload = (await response.json()) as { access_token: string; expires_in: number };
    await this.cache.cacheTwitchToken(payload.access_token, payload.expires_in);
    return payload.access_token;
  }

  private async helix<T>(path: string, retryOnAuthFailure = true): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await fetch(`${HELIX_URL}${path}`, {
        headers: { "Client-Id": this.credentials.clientId, Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw upstreamError("Twitch", error);
    }

    // Токен могли отозвать раньше срока — один повтор с новым токеном.
    if (response.status === 401 && retryOnAuthFailure) {
      await this.cache.forgetTwitchToken();
      return await this.helix<T>(path, false);
    }
    if (!response.ok) {
      throw new AppError("upstream_unavailable", "Twitch ответил ошибкой на запрос списка записей.");
    }
    return (await response.json()) as T;
  }
}

interface RawVideo {
  id: string;
  title: string;
  url: string;
  created_at: string;
  published_at?: string;
  duration: string;
  stream_id?: string;
  viewable?: string;
  muted_segments?: Array<{ offset: number; duration: number }> | null;
}

function toVideo(raw: RawVideo): TwitchVideo {
  const publishedAt = raw.published_at ?? raw.created_at;
  return {
    vodId: raw.id,
    title: raw.title,
    url: raw.url,
    publishedAt,
    publishedAtUnix: Math.floor(new Date(publishedAt).getTime() / 1000),
    durationSeconds: parseTwitchDuration(raw.duration),
    streamId: raw.stream_id ?? "",
    viewable: raw.viewable ?? "public",
    mutedSegments: (raw.muted_segments ?? []).map((segment) => ({
      offsetSeconds: segment.offset,
      durationSeconds: segment.duration,
    })),
  };
}

/**
 * Ниже этого запись разбору не подлежит.
 *
 * Площадка заводит запись архива в первые секунды трансляции, поэтому
 * неудавшийся запуск эфира оставляет после себя запись в несколько десятков
 * секунд. Разбирать в ней нечего, а путь она проходит полный: скачивание,
 * нарезка, распознавание — и только потом выясняется, что фраз нет.
 *
 * Три минуты, а не «несколько секунд»: замеры архива канала дали обрывки от
 * десяти до тридцати семи секунд, ближайшая настоящая запись — два часа
 * сорок восемь минут, так что любая граница между ними отсекает то же самое.
 * Взята круглая: её видно в тексте причины, который читает человек.
 */
export const MIN_STREAM_SECONDS = 180;

/**
 * Причина, по которой запись не берётся в работу. Возвращается текст для
 * человека либо `undefined`, если препятствий нет.
 *
 * Про доступ только подписчикам площадка в списке записей не сообщает —
 * это выясняется при скачивании, в боксе. Здесь отсекается то, что видно
 * заранее.
 *
 * Признак один на все пути запуска разбора: и расписание, и ручное
 * добавление, и повторный разбор спрашивают эту же функцию. Отдельная
 * проверка у вызывающих однажды уже разошлась бы с этой.
 */
export function skipReason(video: TwitchVideo): string | undefined {
  if (video.viewable !== "public") {
    return "Запись закрыта: доступна не всем зрителям.";
  }
  // Нулевая длительность отдельного случая не заслуживает: ноль секунд
  // короче трёх минут и получает ту же причину.
  if (video.durationSeconds < MIN_STREAM_SECONDS) {
    return "Запись короче трёх минут — разбирать в ней нечего.";
  }
  return undefined;
}
