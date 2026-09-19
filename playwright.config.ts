import { defineConfig } from "@playwright/test";

/**
 * Проверки страницы в настоящем браузере.
 *
 * Остальные проверки рисуют разметку без браузера: в них нельзя нажать кнопку
 * и посмотреть, что получилось на экране. А именно там и живут ошибки вроде
 * «нажал — а страница сказала не то»: сервис отвечает пропуском, а список
 * переводит запись в «В обработке» и обещает работу, которой нет.
 *
 * Сервис для проверок поднимается не здесь, а в `tests/e2e/fixtures.ts` —
 * способом, который Cloudflare называет для проверок Worker'а целиком:
 * `createTestHarness()` запускает сборку по её настройке и отдаёт адрес
 * ([документация](https://developers.cloudflare.com/workers/testing/test-harness/),
 * [применение с Playwright](https://developers.cloudflare.com/workers/testing/test-harness/integrations/)).
 */

export default defineConfig({
  testDir: "./tests/e2e",
  // Расширение `.e2e.ts`, а не `.test.ts`: Vitest собирает всё, что названо
  // тестом, и на файле с проверками Playwright падал бы — их `test()`
  // работает только под своим запускающим.
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Страница собирается до проверок: сервис отдаёт собранное, а не исходники,
  // и адрес реестра в неё закладывается подставной — реестр она читает прямо
  // из браузера, и промах мимо заглушки не должен ни к чему приводить.
  globalSetup: "./tests/e2e/build.ts",
  use: {
    trace: "retain-on-failure",
    // Разделы страницы перечислены в шапке и на узком экране прячутся в меню;
    // проверяется страница, а не поведение шапки.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
