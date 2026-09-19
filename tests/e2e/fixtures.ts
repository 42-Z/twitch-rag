import { test as base } from "@playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { STUB_SECRETS } from "./settings.ts";

/**
 * Сервис для проверок страницы.
 *
 * Поднимается тем же способом, каким Cloudflare велит проверять Worker целиком:
 * `createTestHarness()` из wrangler запускает сборку по её же настройке и отдаёт
 * адрес, по которому она отвечает
 * ([документация](https://developers.cloudflare.com/workers/testing/test-harness/)).
 * Своими руками ни сборку, ни порт заводить не надо, и проверяется при этом то,
 * что выпускается, а не отдельная сборка для проверок.
 *
 * Секреты подменяются здесь же, штатным способом проверочного набора, а не
 * ключами запуска: настоящие значения секретов живут в `.env` и в проверки
 * попадать не должны. Подставные адреса ведут в никуда, поэтому промах мимо
 * заглушки приводит к отказу, а не к обращению к боевому хранилищу.
 */

export interface HarnessFixture {
  harness: TestHarness;
  /** Адрес, по которому отвечает поднятый сервис. */
  url: string;
}

export const test = base.extend<{ server: HarnessFixture; reset: void }, { harness: TestHarness }>({
  // Сервис поднимается один на весь прогон: он не хранит состояния между
  // проверками — хранилища подставные, — а подъём стоит секунд.
  harness: [
    async ({}, use) => {
      const harness = createTestHarness({
        workers: [{ configPath: "./wrangler.jsonc", secrets: STUB_SECRETS }],
      });
      await harness.listen();
      await use(harness);
      await harness.close();
    },
    { scope: "worker" },
  ],

  server: async ({ harness }, use) => {
    const { url } = await harness.listen();
    await use({ harness, url: url.href.replace(/\/$/, "") });
  },

  baseURL: async ({ server }, use) => {
    await use(server.url);
  },

  // Хранилища между проверками возвращаются в исходное состояние, а упавшая
  // проверка оставляет в отчёте то, что происходило внутри сервиса.
  reset: [
    async ({ harness }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) harness.debug();
      await harness.reset();
    },
    { auto: true },
  ],
});
