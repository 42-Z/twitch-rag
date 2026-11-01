import { test, expect, describe, afterEach } from "vitest";
import { Registry } from "../../src/shared/registry.ts";

/**
 * Полное чтение реестра — на подменённой сети, со счётом запросов.
 *
 * Считать здесь приходится потому, что каждое обращение к Upstash — отдельный
 * HTTP-запрос, а на бесплатном тарифе Cloudflare на вызов Worker разрешено 50
 * внешних обращений
 * (https://developers.cloudflare.com/workers/platform/limits/#subrequests).
 * Чтение по одной записи на запрос съедало почти весь предел на реестре в 39
 * записей, и часовая проверка падала, не успев запустить разбор.
 *
 * Проверка падает, если чтение снова пойдёт по одной записи: на четырёхстах
 * записях это 401 запрос вместо 5.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FakeRecord {
  id: string;
  /** Вес в списке — момент публикации, как у настоящего реестра. */
  weight: number;
  fields: Record<string, string>;
}

interface Stub {
  /** Пути запросов по порядку: `/` — одна команда, `/pipeline` — пачка. */
  paths: string[];
}

/**
 * Реестр в памяти, отвечающий по протоколу Upstash: список — упорядоченным
 * множеством, записи — хешами. `absent` — ключи, которых в хранилище нет,
 * хотя в списке они есть.
 */
function stubRegistry(records: FakeRecord[], absent: string[] = []): Stub {
  const paths: string[] = [];

  const run = (command: Array<string | number>): unknown => {
    const name = String(command[0]).toLowerCase();
    const key = String(command[1]);
    const rest = command.slice(2);
    if (name === "zrange") {
      const first = Number(rest[0]);
      const second = Number(rest[1]);
      const flags = rest.slice(2).map(String);
      const rev = flags.includes("rev");
      // С BYSCORE REV границы идут от большей к меньшей — так их и передаёт SDK.
      const low = rev ? second : first;
      const high = rev ? first : second;
      const selected = [...records]
        .filter((record) => record.weight >= low && record.weight <= high)
        .sort((a, b) => a.weight - b.weight);
      return (rev ? selected.reverse() : selected).map((record) => record.id);
    }
    if (name === "hgetall") {
      const id = key.replace(/^stream:/, "");
      const record = absent.includes(key) ? undefined : records.find((item) => item.id === id);
      return record === undefined ? [] : Object.entries(record.fields).flat();
    }
    throw new Error(`Подмена реестра не знает команды ${name}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "null")) as Array<string | number> | Array<Array<string | number>>;
    const pipelined = path.endsWith("/pipeline");
    paths.push(pipelined ? "/pipeline" : "/");
    const commands = pipelined ? (body as Array<Array<string | number>>) : [body as Array<string | number>];
    const results = commands.map((command) => ({ result: encode(run(command)) }));
    return new Response(JSON.stringify(pipelined ? results : results[0]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { paths };
}

/** Клиент просит ответ в base64 и раскодирует его сам. */
function encode(value: unknown): unknown {
  if (typeof value === "string") return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  if (Array.isArray(value)) return value.map(encode);
  return value;
}

function registry(): Registry {
  return new Registry({ url: "https://example.upstash.io", token: "token" });
}

function record(index: number): FakeRecord {
  return {
    id: `23456789${String(index).padStart(2, "0")}`,
    weight: 1_700_000_000 + index,
    fields: {
      vodId: `23456789${String(index).padStart(2, "0")}`,
      status: "ready",
      title: `Эфир ${index}`,
      url: `https://www.twitch.tv/videos/23456789${String(index).padStart(2, "0")}`,
      publishedAt: "2026-10-01T18:00:00Z",
      publishedAtUnix: String(1_700_000_000 + index),
      durationSeconds: "7200",
      categories: "[]",
      source: "auto",
      attempts: "1",
    },
  };
}

const many = (count: number): FakeRecord[] => Array.from({ length: count }, (_, index) => record(index));

describe("число обращений при полном чтении", () => {
  test("одна запись — список и пачка, два запроса", async () => {
    const stub = stubRegistry(many(1));

    const streams = await registry().listStreams();

    expect(streams).toHaveLength(1);
    expect(stub.paths).toEqual(["/", "/pipeline"]);
  });

  test("четыреста записей — четыре пачки по сто, пять запросов", async () => {
    const stub = stubRegistry(many(400));

    const streams = await registry().listStreams();

    expect(streams).toHaveLength(400);
    expect(stub.paths).toEqual(["/", "/pipeline", "/pipeline", "/pipeline", "/pipeline"]);
  });

  test("предел выборки не читает лишнего", async () => {
    const stub = stubRegistry(many(400));

    const streams = await registry().listStreams({ limit: 20 });

    expect(streams).toHaveLength(20);
    expect(stub.paths).toEqual(["/", "/pipeline"]);
  });
});

describe("содержимое прочитанного пачкой", () => {
  test("запись не отличается от прочитанной по одной", async () => {
    stubRegistry(many(3));
    const batched = await registry().listStreams();

    stubRegistry(many(3));
    const single = await registry().getStream("2345678901");

    expect(batched[1]).toEqual(single);
  });

  test("порядок — новые первыми, как в списке", async () => {
    stubRegistry(many(3));

    const streams = await registry().listStreams();

    expect(streams.map((stream) => stream.streamId)).toEqual(["2345678902", "2345678901", "2345678900"]);
  });

  test("цифровой идентификатор становится строкой", async () => {
    // Список приходит из JSON, и участник, состоящий из цифр, возвращается
    // числом. Проверка «эту запись уже брали» сверяет его со строкой с
    // площадки, поэтому приведение обязательно.
    stubRegistry([
      {
        id: "2345678901",
        weight: 1,
        fields: { status: "ready", publishedAtUnix: "1", attempts: "1", categories: "[]", source: "auto" },
      },
    ]);

    const streams = await registry().listStreams();

    expect(streams[0]?.streamId).toBe("2345678901");
  });

  test("запись, исчезнувшая между списком и чтением, пропускается молча", async () => {
    // Между списком и чтением запись могли удалить: ключа уже нет, и это не
    // повод валить всю выборку.
    stubRegistry(many(3), ["stream:2345678901"]);

    const streams = await registry().listStreams();

    expect(streams.map((stream) => stream.streamId)).toEqual(["2345678902", "2345678900"]);
  });
});
