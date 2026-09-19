import { defineConfig } from "@playwright/test";
import { BASE_URL, DEAD, PORT, TOKEN } from "./tests/e2e/settings.ts";

/**
 * Проверки страницы в настоящем браузере.
 *
 * Остальные проверки рисуют разметку без браузера: в них нельзя нажать кнопку
 * и посмотреть, что получилось на экране. А именно там и живут ошибки вроде
 * «нажал — а страница сказала не то»: сервис отвечает пропуском, а список
 * переводит запись в «В обработке» и обещает работу, которой нет.
 *
 * Сервис поднимается здесь же, но с подставным окружением: адреса хранилищ
 * ведут в никуда (`--var` перебивает значения из `.env`), поэтому ни один
 * запрос не может дойти до боевых данных, даже если перехват в проверке
 * не сработает. Сама страница собирается с подставным адресом реестра по той
 * же причине: реестр она читает из браузера, и промах мимо заглушки не должен
 * ни к чему приводить.
 */

/** Подставное окружение: значения перебивают `.env` и уводят запросы в никуда. */
const STUBBED = [
  `--var APP_ADMIN_TOKEN:${TOKEN}`,
  `--var UPSTASH_REDIS_REST_URL:${DEAD}`,
  `--var UPSTASH_REDIS_REST_TOKEN:stub`,
  `--var UPSTASH_VECTOR_REST_URL:${DEAD}`,
  `--var UPSTASH_VECTOR_REST_TOKEN:stub`,
  `--var UPSTASH_BLOB_TOKEN:stub`,
  `--var OPENROUTER_API_KEY:stub`,
  `--var TWITCH_CLIENT_ID:stub`,
  `--var TWITCH_CLIENT_SECRET:stub`,
  `--var INGEST_SECRET:stub`,
].join(" ");

export default defineConfig({
  testDir: "./tests/e2e",
  // Расширение `.e2e.ts`, а не `.spec.ts`: `bun test` собирает по всему
  // проекту всё, что названо тестом, и на файле с проверками Playwright
  // падал бы — их `test()` работает только под своим запускающим.
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  // Сервис один на все проверки, и записи в реестре-заглушке он не хранит:
  // параллельные проверки мешали бы друг другу впустую.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Разделы страницы перечислены в шапке и на узком экране прячутся в меню;
    // проверяется страница, а не поведение шапки.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command:
      `BUN_PUBLIC_REGISTRY_URL=${DEAD} BUN_PUBLIC_REGISTRY_READONLY_TOKEN=stub bun run build && ` +
      `bunx wrangler dev --port ${PORT} ${STUBBED}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
