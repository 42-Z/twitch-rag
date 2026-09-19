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
 * Токен хранилища документов: подставной, но правильной формы. Клиент Upstash
 * разбирает его прямо при создании и на произвольной строке падает раньше,
 * чем Worker дойдёт до проверяемого пути, — сервис отвечал 500 с пустым
 * журналом. Форма — как у настоящего: версия, флаги, длины частей и сами
 * части, в base64url.
 */
export function stubBlobToken(): string {
  const [id, password, domainHash] = ["bucket", "password", "blob.test"].map((part) => Buffer.from(part)) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  const head = Buffer.from([2, 0, id.length, password.length >> 8, password.length & 0xff, domainHash.length]);
  return Buffer.concat([head, id, password, domainHash]).toString("base64url");
}

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
  UPSTASH_BLOB_TOKEN: stubBlobToken(),
  OPENROUTER_API_KEY: "stub",
  TWITCH_CLIENT_ID: "stub",
  TWITCH_CLIENT_SECRET: "stub",
  INGEST_SECRET: "stub",
  UPSTASH_BOX_API_KEY: "stub",
  UPSTASH_BOX_ID: "stub",
};
