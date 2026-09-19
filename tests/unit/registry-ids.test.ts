import { test, expect, describe, afterEach } from "vitest";
import { Registry } from "../../src/shared/registry.ts";

/**
 * Разбор ответа реестра — на подменённой сети, без живого сервиса.
 *
 * Проверять это стоит именно так: дело не в сервисе, а в разборе ответа.
 * SDK разбирает значения как JSON, поэтому участник множества, состоящий из
 * одних цифр, возвращается числом. Объявленный тип `string[]` этого не
 * выражает, и молчание компилятора здесь ничего не значит: `zrange<string[]>`
 * — приведение типа, а не преобразование.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Ответ на любую команду. Значения закодированы: SDK просит ответ в base64 и
 * разбирает его сам, — поэтому подставленное значение доезжает до кода в том
 * виде, в каком его прислал бы сервис.
 */
function stubRedis(result: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function registry(): Registry {
  return new Registry({ url: "https://example.upstash.io", token: "token" });
}

describe("идентификаторы известных записей", () => {
  test("цифровой идентификатор возвращается строкой, а не числом", () => {
    // Иначе проверка «эту запись уже брали» не срабатывает: идентификаторы
    // площадки приходят строками, и обход архива каждый раз шёл бы до конца
    // вместо остановки на первой известной записи.
    stubRedis([btoa("2345678901")]);

    return registry()
      .knownVodIds()
      .then((ids) => {
        expect(typeof ids[0]).toBe("string");
        expect(ids).toEqual(["2345678901"]);
      });
  });

  test("нецифровые идентификаторы остаются собой", () => {
    stubRedis([btoa("abc"), btoa("2345678901"), btoa("")]);

    return registry()
      .knownVodIds()
      .then((ids) => {
        expect(ids).toEqual(["abc", "2345678901", ""]);
      });
  });
});
