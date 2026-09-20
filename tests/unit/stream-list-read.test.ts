import { test, expect, describe, afterEach, vi } from "vitest";

/**
 * Чтение списка трансляций из реестра — на подменённой сети.
 *
 * Проверяется здесь потому, что ошибка одной команды приходит в общем ответе
 * отдельной записью, а не отказом всего запроса. Код, читавший только поле с
 * результатом, превращал сбойную команду в пустоту: разбор такой записи
 * возвращал `undefined`, и она молча пропадала из списка — владелец видел
 * неполный список и ни одного сообщения об ошибке.
 */
// Адрес подставляется до загрузки модуля: он читает его один раз при
// импорте, и без этого проверка зависела бы от того, подложено ли окружение.
vi.stubEnv("VITE_REGISTRY_URL", "https://registry.test");
vi.stubEnv("VITE_REGISTRY_READONLY_TOKEN", "readonly-token");

const { listStreams } = await import("../../src/ui/lib/registry.ts");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Указатель отдаёт одну запись, а пакетное чтение отвечает заданным исходом. */
function stubRegistry(pipeline: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = String(input).endsWith("/pipeline")
      ? JSON.stringify(pipeline)
      : JSON.stringify({ result: ["1"] });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("чтение списка из реестра", () => {
  test("ошибка отдельной команды не превращается в пропажу записи", () => {
    stubRegistry([{ error: "WRONGTYPE Operation against a key holding the wrong kind of value" }]);

    return expect(listStreams()).rejects.toThrow(/WRONGTYPE/);
  });

  test("годный ответ читается как прежде", async () => {
    stubRegistry([{ result: ["vodId", "1", "status", "ready"] }]);

    const streams = await listStreams();

    expect(streams).toHaveLength(1);
    expect(streams[0]?.streamId).toBe("1");
    expect(streams[0]?.vodId).toBe("1");
    expect(streams[0]?.status).toBe("ready");
  });

  test("запись части читается с номером, числом частей и началом", async () => {
    stubRegistry([
      {
        result: [
          "vodId", "1", "status", "processing", "part", "2", "partCount", "3",
          "partStartSeconds", "21600", "publishedAtUnix", "1789599269", "publishedAt", "2026-09-16T22:54:29Z",
        ],
      },
    ]);

    const streams = await listStreams();

    expect(streams[0]).toMatchObject({ streamId: "1", vodId: "1", part: 2, partCount: 3, partStartSeconds: 21600 });
    expect(streams[0]?.publishedAtUnix).toBe(1789599269);
  });
});
