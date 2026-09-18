import { test, expect, describe, afterEach } from "bun:test";

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
process.env.BUN_PUBLIC_REGISTRY_URL = "https://registry.test";
process.env.BUN_PUBLIC_REGISTRY_READONLY_TOKEN = "readonly-token";

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
    expect(streams[0]?.vodId).toBe("1");
    expect(streams[0]?.status).toBe("ready");
  });
});
