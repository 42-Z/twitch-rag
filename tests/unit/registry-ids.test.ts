import { test, expect, describe, afterEach } from "vitest";
import { Registry } from "../../src/shared/registry.ts";

/**
 * Разбор ответа реестра — на подменённой сети, без живого сервиса.
 *
 * Проверять это стоит именно так: дело не в сервисе, а в разборе ответа.
 * SDK разбирает значения как JSON, поэтому число, записанное строкой,
 * возвращается числом. Объявленный тип этого не выражает, и молчание
 * компилятора здесь ничего не значит: `zrange<string[]>` — приведение типа,
 * а не преобразование.
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

describe("запись части эфира", () => {
  const hash = (pairs: Record<string, string>) => Object.entries(pairs).flatMap(([key, value]) => [btoa(key), btoa(value)]);

  test("поля части читаются обратно, а идентификатор берётся из ключа", async () => {
    stubRedis(
      hash({
        vodId: "2345678901",
        status: "ready",
        part: "2",
        partCount: "3",
        partStartSeconds: "21600",
        attempts: "1",
      }),
    );

    const record = await registry().getStream("2345678901-p2");

    expect(record?.streamId).toBe("2345678901-p2");
    expect(record?.vodId).toBe("2345678901");
    expect(record?.part).toBe(2);
    expect(record?.partCount).toBe(3);
    expect(record?.partStartSeconds).toBe(21600);
  });

  test("у неделёной записи полей части нет, а идентификатор равен ключу", async () => {
    stubRedis(hash({ status: "ready", attempts: "1" }));

    const record = await registry().getStream("2345678901");

    expect(record?.streamId).toBe("2345678901");
    expect(record?.vodId).toBe("2345678901");
    expect("part" in (record ?? {})).toBe(false);
    expect("partCount" in (record ?? {})).toBe(false);
    expect("partStartSeconds" in (record ?? {})).toBe(false);
  });
});
