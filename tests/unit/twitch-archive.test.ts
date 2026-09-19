import { test, expect, describe, afterEach } from "vitest";
import { Twitch, type TokenCache, type TwitchVideo } from "../../src/shared/twitch.ts";

/**
 * Просмотр архива страницами: за один запуск берётся одна запись к разбору,
 * поэтому окно в одну страницу пропускало бы эфиры, появившиеся за время
 * простоя. Сеть подменена — проверяется само решение о перелистывании.
 */
const cache: TokenCache = {
  getCachedTwitchToken: async () => "token",
  cacheTwitchToken: async () => undefined,
  forgetTwitchToken: async () => undefined,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function page(ids: string[], cursor?: string): Response {
  return new Response(
    JSON.stringify({
      data: ids.map((id) => ({
        id,
        title: `Эфир ${id}`,
        url: `https://www.twitch.tv/videos/${id}`,
        published_at: "2026-03-14T18:03:00Z",
        duration: "1h0m0s",
        viewable: "public",
      })),
      ...(cursor === undefined ? {} : { pagination: { cursor } }),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

/** Отвечает страницами по очереди и запоминает, сколько раз спросили. */
function stubPages(pages: Response[]): { calls: () => number } {
  let call = 0;
  globalThis.fetch = (async () => {
    const response = pages[call];
    call += 1;
    if (response === undefined) throw new Error("запрошена лишняя страница");
    return response;
  }) as unknown as typeof fetch;
  return { calls: () => call };
}

const twitch = new Twitch({ clientId: "id", clientSecret: "secret" }, cache);

describe("просмотр архива страницами", () => {
  test("останавливается на первой известной записи, не листая дальше", async () => {
    const stub = stubPages([page(["5", "4", "3", "2"], "cursor-1")]);
    const seen: TwitchVideo[] = [];
    const result = await twitch.listArchive("42", {
      pageSize: 20,
      maxPages: 5,
      stopAt: (video) => {
        seen.push(video);
        return video.vodId === "3";
      },
    });

    // Страница забирается целиком, а проверка прекращается на первой
    // известной записи: до «2» дело уже не доходит.
    expect(result.map((video) => video.vodId)).toEqual(["5", "4", "3", "2"]);
    expect(seen.map((video) => video.vodId)).toEqual(["5", "4", "3"]);
    expect(stub.calls()).toBe(1);
  });

  test("листает дальше, пока известного нет, и уважает предел страниц", async () => {
    const stub = stubPages([page(["9", "8"], "c1"), page(["7", "6"], "c2"), page(["5", "4"], "c3")]);
    const result = await twitch.listArchive("42", { pageSize: 2, maxPages: 3, stopAt: () => false });

    expect(result.map((video) => video.vodId)).toEqual(["9", "8", "7", "6", "5", "4"]);
    expect(stub.calls()).toBe(3);
  });

  test("отсутствие курсора прекращает просмотр", async () => {
    const stub = stubPages([page(["3", "2"])]);
    const result = await twitch.listArchive("42", { pageSize: 2, maxPages: 5, stopAt: () => false });

    expect(result).toHaveLength(2);
    expect(stub.calls()).toBe(1);
  });

  test("пустая страница прекращает просмотр", async () => {
    const stub = stubPages([page([], "c1")]);
    const result = await twitch.listArchive("42", { pageSize: 20, maxPages: 5, stopAt: () => false });

    expect(result).toEqual([]);
    expect(stub.calls()).toBe(1);
  });
});
