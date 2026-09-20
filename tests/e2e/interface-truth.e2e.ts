import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./fixtures.ts";
import { DEAD, TOKEN } from "./settings.ts";

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

/**
 * Реестр со своим содержимым: перечень идентификаторов в том порядке, в каком
 * его отдаёт индекс (от новых к старым), и поля записей по идентификатору.
 * Без него реестр отдаёт одну пропущенную запись.
 */
let registryScenario: { ids: string[]; fields: Record<string, string[]> } | undefined;

/** Ответ хранилища на команду: плоский ответ либо результат с ошибкой. */
function registryAnswer(command: unknown[]): unknown {
  const name = String(command[0] ?? "").toUpperCase();
  if (name === "ZRANGE") return registryScenario?.ids ?? [VOD_ID];
  if (name === "HGETALL" && command[1] === "channel") return ["login", "5opka", "displayName", "5opka"];
  if (name === "HGETALL" && registryScenario !== undefined) {
    return registryScenario.fields[String(command[1]).replace(/^stream:/, "")] ?? [];
  }
  if (name === "HGETALL") return streamFields();
  return null;
}

/**
 * Заглушки сети. Локальному сервису отдаются только страница и её файлы —
 * всё остальное, включая обращения к реестру из браузера, перехвачено.
 */
async function stubServices(
  page: Page,
  siteUrl: string,
  answers: { reparse?: unknown; add?: unknown },
): Promise<void> {
  const siteHost = new URL(siteUrl).host;
  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Локальный сервис — только страница и её файлы: всё остальное, включая
    // обращения к реестру прямо из браузера, перехвачено ниже.
    const local = url.host === siteHost;

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

test("сервис для проверок поднят с подставным окружением", async ({ server }) => {
  // Сторож: проверки не должны ходить в боевые хранилища. Пропадут из подъёма
  // подставные секреты — эта проверка упадёт раньше, чем что-нибудь попадёт
  // в боевой реестр.
  const env = await server.harness
    .getWorker<{ UPSTASH_REDIS_REST_URL: string; APP_ADMIN_TOKEN: string }>()
    .getEnv();
  expect(env.UPSTASH_REDIS_REST_URL).toBe(DEAD);
  expect(env.APP_ADMIN_TOKEN).toBe(TOKEN);
});

test("добавление короткой записи: страница называет причину, а не обещает разбор", async ({ page, server }) => {
  await stubServices(page, server.url, {});
  await enterToken(page);

  await page.getByLabel("Адрес записи").fill(VOD_URL);
  await page.getByRole("button", { name: "Добавить" }).click();

  await expect(page.getByText(SHORT_REASON)).toBeVisible();
  await expect(page.getByText("Запись принята в обработку.")).toHaveCount(0);
});

test("повторный разбор обрывка: причина рядом с записью, разбор не начат", async ({ page, server }) => {
  await stubServices(page, server.url, {});
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

test("стили компонентов попали в сборку", async ({ page, server }) => {
  // Сторож сборки: классы Tailwind ищутся от корня сборки, а у Vite он — папка
  // страницы. Без явного указания источника компоненты из `src/components`
  // оставались без стилей, и сборка проходила, не сказав ни слова. Кнопка
  // меню — квадрат 36 пикселей только благодаря классу из `components/ui`.
  await stubServices(page, server.url, {});
  await page.goto("/manage");
  const box = await page.getByRole("button", { name: "Открыть меню" }).boundingBox();
  expect(box?.width).toBe(36);
  expect(box?.height).toBe(36);
});

/** Поля записи разобранного или разбираемого эфира, как их отдаёт хранилище. */
function fieldsOf(vodId: string, extra: Record<string, string>): string[] {
  const base: Record<string, string> = {
    vodId,
    status: "ready",
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: "2026-09-16T12:00:00Z",
    publishedAtUnix: "1789560000",
    durationSeconds: "10800",
    categories: "[]",
    sectionCount: "5",
    source: "auto",
    attempts: "1",
    ...extra,
  };
  return Object.entries(base).flat();
}

test("части одного эфира стоят подряд и по порядку, у каждой видно, какая она", async ({ page, server }) => {
  // Индекс отдаёт записи от новых к старым, и вторая часть эфира идёт в нём
  // раньше первой. Страница обязана поставить их по порядку эфира.
  registryScenario = {
    ids: ["300", "200-p2", "200-p1", "100"],
    fields: {
      "300": fieldsOf("300", { docTitle: "Свежий эфир", publishedAtUnix: "1789646400" }),
      "200-p2": fieldsOf("200", {
        docTitle: "Игра (часть 2 из 2)",
        part: "2",
        partCount: "2",
        partStartSeconds: "10800",
        publishedAtUnix: "1789570800",
      }),
      "200-p1": fieldsOf("200", {
        docTitle: "Игра (часть 1 из 2)",
        part: "1",
        partCount: "2",
        partStartSeconds: "0",
        publishedAtUnix: "1789560000",
      }),
      "100": fieldsOf("100", { docTitle: "Старый эфир", publishedAtUnix: "1789473600" }),
    },
  };
  try {
    await stubServices(page, server.url, {});
    await page.goto("/knowledge");

    const names = page.locator("li p.font-medium");
    await expect(names).toHaveCount(4);
    expect(await names.allTextContents()).toEqual([
      "Свежий эфир",
      "Игра (часть 1 из 2)",
      "Игра (часть 2 из 2)",
      "Старый эфир",
    ]);
  } finally {
    registryScenario = undefined;
  }
});

test("часть без имени опознаётся по дате и номеру части", async ({ page, server }) => {
  registryScenario = {
    ids: ["200-p2"],
    fields: {
      "200-p2": fieldsOf("200", {
        status: "processing",
        part: "2",
        partCount: "3",
        partStartSeconds: "7200",
      }),
    },
  };
  try {
    await stubServices(page, server.url, {});
    await page.goto("/knowledge");

    await expect(page.getByText(/· часть 2 из 3/)).toBeVisible();
    await expect(page.getByText("разбирается…")).toBeVisible();
  } finally {
    registryScenario = undefined;
  }
});
