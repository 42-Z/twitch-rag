/**
 * Что у проверок страницы общего: подставное окружение и токен владельца.
 *
 * Вынесено отдельно, потому что эти значения нужны в двух местах — в подъёме
 * сервиса для проверок и в смене боевых значений на подставные.
 */

/** Адрес, заведомо никуда не ведущий: туда уходят подставные хранилища. */
export const DEAD = "http://127.0.0.1:9";

/** Токен владельца для проверок — не тот, что в бою. */
export const TOKEN = "e2e-token";

/**
 * Подставные значения секретов сервиса.
 *
 * Адреса хранилищ ведут в никуда, поэтому промах мимо заглушки приводит к
 * отказу, а не к записи в боевой реестр. Настоящие значения берутся из `.env`
 * при запуске сервиса, и подменить их из проверок нечем — они секреты.
 */
export const STUB_SECRETS: Record<string, string> = {
  APP_ADMIN_TOKEN: TOKEN,
  UPSTASH_REDIS_REST_URL: DEAD,
  UPSTASH_REDIS_REST_TOKEN: "stub",
  UPSTASH_VECTOR_REST_URL: DEAD,
  UPSTASH_VECTOR_REST_TOKEN: "stub",
  UPSTASH_BLOB_TOKEN: "stub",
  OPENROUTER_API_KEY: "stub",
  TWITCH_CLIENT_ID: "stub",
  TWITCH_CLIENT_SECRET: "stub",
  INGEST_SECRET: "stub",
  UPSTASH_BOX_API_KEY: "stub",
  UPSTASH_BOX_ID: "stub",
};
