/**
 * Привязки и секреты Worker.
 *
 * Значения секретов ставятся `wrangler secret put` и в репозиторий не
 * попадают. Публичные значения для страницы (адрес реестра и токен только на
 * чтение) сюда не входят: они уходят в сборку интерфейса.
 */

import { Registry } from "../shared/registry.ts";
import { Knowledge } from "../shared/knowledge.ts";
import { Documents } from "../shared/documents.ts";
import { OpenRouter } from "../shared/openrouter.ts";
import { Twitch } from "../shared/twitch.ts";

export interface Env {
  // --- привязки платформы ---
  /** Куски аудио на время разбора. */
  AUDIO: R2Bucket;
  /** Разбор записи как последовательность шагов с независимыми повторами. */
  INGEST: Workflow<IngestParams>;
  /** Статика интерфейса. */
  ASSETS: Fetcher;
  /** Ограничитель частоты публичных путей; на локальном запуске может отсутствовать. */
  PUBLIC_RATE_LIMITER?: RateLimit;

  // --- обычные переменные (не секреты) ---
  /** Публичный адрес сервиса — нужен расписанию, чтобы позвать бокс: у него нет входящего запроса. */
  WORKER_URL: string;

  // --- секреты ---
  OPENROUTER_API_KEY: string;
  UPSTASH_VECTOR_REST_URL: string;
  UPSTASH_VECTOR_REST_TOKEN: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  UPSTASH_BLOB_TOKEN: string;
  UPSTASH_BOX_API_KEY: string;
  UPSTASH_BOX_ID: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  /** Общий секрет между боксом и Worker. */
  INGEST_SECRET: string;
  /** Токен владельца: добавление, удаление, смена канала. */
  APP_ADMIN_TOKEN: string;
}

/** Данные, с которыми запускается разбор одной записи. */
export interface IngestParams {
  vodId: string;
  title: string;
  url: string;
  publishedAt: string;
  durationSeconds: number;
  categories: Array<{ title: string; startSeconds: number; endSeconds: number }>;
  chunks: Array<{ index: number; key: string; offsetSeconds: number; durationSeconds: number }>;
}

export interface Services {
  registry: Registry;
  knowledge: Knowledge;
  documents: Documents;
  models: OpenRouter;
  twitch: Twitch;
}

/**
 * Адаптеры внешних сервисов собираются в одном месте: прикладной код не
 * обращается к их SDK напрямую и не знает, откуда берутся ключи.
 */
export function createServices(env: Env): Services {
  const registry = new Registry({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return {
    registry,
    knowledge: new Knowledge({
      url: env.UPSTASH_VECTOR_REST_URL,
      token: env.UPSTASH_VECTOR_REST_TOKEN,
    }),
    documents: new Documents({ token: env.UPSTASH_BLOB_TOKEN }),
    models: new OpenRouter(env.OPENROUTER_API_KEY),
    twitch: new Twitch(
      { clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET },
      registry,
    ),
  };
}
