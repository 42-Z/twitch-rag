import { expect, test, type Page, type Route } from "@playwright/test";
import { HOST, TOKEN } from "./settings.ts";

/**
 * Что страница говорит владельцу, когда запись в разбор не взяли.
 *
 * Сервис отвечает пропуском: запись короче трёх минут или доступна не всем
 * зрителям. Это не сбой — владелец сделал всё правильно, — но и не работа.
 * Показать её разбираемой значит обещать то, чего не будет: владелец пойдёт
 * искать документ, которого нет.
 *
 * Проверка идёт в настоящем браузере, потому что ошибка живёт ровно здесь:
 * ответ сервиса правильный, а страница его выбрасывает.
 */

/** Ответ сервиса на попытку разобрать обрывок. */
const SHORT_REASON = "Запись короче трёх минут — разбирать в ней нечего.";
/** Причина, с которой запись лежит в реестре: другая, чтобы отличить её от ответа. */
const STORED_REASON = "Запись закрыта: доступна не всем зрителям.";

const VOD_ID = "2830322015";
const VOD_URL = `https://www.twitch.tv/videos/${VOD_ID}`;

/** Поля записи так, как их отдаёт хранилище: плоский список «поле, значение». */
function streamFields(): string[] {
  return [
    "vodId", VOD_ID,
    "status", "skipped",
    "title", "РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ",
    "url", VOD_URL,
    "publishedAt", "2026-07-27T12:00:00Z",
    "publishedAtUnix", "1785153600",
    "durationSeconds", "16",
    "categories", "[]",
    "source", "manual",
    "attempts", "0",
    "reason", STORED_REASON,
  ];
}

/** Ответ хранилища на команду: плоский ответ либо результат с ошибкой. */
function registryAnswer(command: unknown[]): unknown {
  const name = String(command[0] ?? "").toUpperCase();
  if (name === "ZRANGE") return [VOD_ID];
  if (name === "HGETALL" && command[1] === "channel") return ["login", "5opka", "displayName", "5opka"];
  if (name === "HGETALL") return streamFields();
  return null;
}

/**
 * Заглушки сети. Локальному сервису отдаются только страница и её файлы —
 * всё остальное, включая обращения к реестру из браузера, перехвачено.
 */
async function stubServices(page: Page, answers: { reparse?: unknown; add?: unknown }): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Локальный сервис — только страница и её файлы: всё остальное, включая
    // обращения к реестру прямо из браузера, перехвачено ниже.
    const local = url.host === HOST;

    if (local && !url.pathname.startsWith("/api/")) return route.continue();

    if (local && url.pathname === "/api/health") {
      await route.fulfill({
        status: 200,
        json: { status: "ok", checks: {}, channel: "5opka", lastCheckedAt: null, lastCheckError: null },
      });
      return;
    }

    if (local && url.pathname.endsWith("/reparse")) {
      await route.fulfill({ status: 200, json: answers.reparse ?? { status: "skipped", reason: SHORT_REASON } });
      return;
    }

    if (local && (url.pathname === "/api/streams" || url.pathname === "/api/streamer" || url.pathname === "/api/channel")) {
      await route.fulfill({ status: 200, json: answers.add ?? { vodId: VOD_ID, status: "skipped", reason: SHORT_REASON } });
      return;
    }

    if (local) {
      await route.fulfill({ status: 200, json: { vodId: VOD_ID, status: "skipped", reason: SHORT_REASON } });
      return;
    }

    // Всё остальное — реестр: страница читает его прямо из браузера.
    const body = request.postDataJSON() as unknown[] | unknown[][];
    if (url.pathname.endsWith("/pipeline")) {
      await route.fulfill({
        status: 200,
        json: (body as unknown[][]).map((command) => ({ result: registryAnswer(command) })),
      });
      return;
    }
    await route.fulfill({ status: 200, json: { result: registryAnswer(body as unknown[]) } });
  });
}

/** Токен вводится на странице управления и живёт до перезагрузки. */
async function enterToken(page: Page): Promise<void> {
  await page.goto("/manage");
  await page.getByLabel("Токен").fill(TOKEN);
  // Токен принят — вместе с ним открываются поля владельца.
  await expect(page.getByRole("heading", { name: "Добавить запись вручную" })).toBeVisible();
}

test("добавление короткой записи: страница называет причину, а не обещает разбор", async ({ page }) => {
  await stubServices(page, {});
  await enterToken(page);

  await page.getByLabel("Адрес записи").fill(VOD_URL);
  await page.getByRole("button", { name: "Добавить" }).click();

  await expect(page.getByText(SHORT_REASON)).toBeVisible();
  await expect(page.getByText("Запись принята в обработку.")).toHaveCount(0);
});

test("повторный разбор обрывка: причина рядом с записью, разбор не начат", async ({ page }) => {
  await stubServices(page, {});
  await enterToken(page);

  // Панель разделов на странице закрыта: она открывается кнопкой в шапке.
  await page.getByRole("button", { name: "Открыть меню" }).click();
  await page.getByRole("link", { name: "Знания" }).click();

  // Запись лежит пропущенной со своей причиной — той, что записана в реестре.
  await expect(page.getByText(STORED_REASON)).toBeVisible();

  // Подтверждение удаления и разбора спрашивается окном браузера.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Разобрать заново" }).click();

  // Ответ сервиса доходит до экрана: причина пропуска, а не обещание работы.
  await expect(page.getByText(SHORT_REASON)).toBeVisible();
  // И запись не уезжает в «В обработке»: разбора нет, показывать его нечем.
  await expect(page.getByText("В обработке")).toHaveCount(0);
  await expect(page.getByText(STORED_REASON)).toBeVisible();
});
