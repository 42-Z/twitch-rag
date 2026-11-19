import { afterEach, describe, expect, test } from "vitest";
import { Registry } from "../../src/shared/registry.ts";

/**
 * Поле для ассистента живёт рядом с полем для разбора, но меняется отдельно:
 * правка одного не должна затирать другое. Проверка ведёт себя как реестр
 * Upstash: хеш `channel`, команды `HGETALL` и `HSET`.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Хранилище в памяти: ключ → хеш. */
function stubRegistry(initial: Record<string, string> = {}): Map<string, Map<string, string>> {
  const store = new Map<string, Map<string, string>>();
  store.set("channel", new Map(Object.entries(initial)));

  const run = (command: string[]): unknown => {
    const [name = "", key = "", ...rest] = command;
    const lower = name.toLowerCase();

    if (lower === "hset") {
      const hash = store.get(key) ?? new Map<string, string>();
      for (let index = 0; index < rest.length; index += 2) {
        hash.set(String(rest[index]), String(rest[index + 1]));
      }
      store.set(key, hash);
      return 1;
    }

    if (lower === "hgetall") {
      const hash = store.get(key);
      return hash === undefined ? [] : [...hash].flat();
    }

    throw new Error(`Подмена реестра не знает команды ${name}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    // Клиент склеивает одиночные команды в пачку сам, поэтому разбираются оба вида.
    const pipelined = path.endsWith("/pipeline") || path.endsWith("/multi-exec");
    const body = JSON.parse(String(init?.body ?? "null")) as unknown;
    const commands = (pipelined ? body : [body]) as string[][];
    const results = commands.map((command) => ({ result: encode(run(command)) }));
    return json(pipelined ? results : results[0]);
  }) as unknown as typeof fetch;

  return store;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Клиент Upstash просит ответ в base64 и раскодирует его сам. */
function encode(value: unknown): unknown {
  if (typeof value === "string") return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  if (Array.isArray(value)) return value.map(encode);
  return value;
}

function registry(): Registry {
  return new Registry({ url: "https://example.upstash.io", token: "token" });
}

describe("поле для ассистента в записи канала", () => {
  test("setAgentStreamerInfo пишет только своё поле", async () => {
    const store = stubRegistry({ login: "channel", streamerInfo: "для разбора" });

    await registry().setAgentStreamerInfo("для ассистента");

    expect(store.get("channel")?.get("agentStreamerInfo")).toBe("для ассистента");
    expect(store.get("channel")?.get("streamerInfo")).toBe("для разбора");
  });

  test("getChannel возвращает новое поле вместе с прежним", async () => {
    stubRegistry({
      login: "channel",
      displayName: "Канал",
      streamerInfo: "для разбора",
      agentStreamerInfo: "для ассистента",
    });

    const channel = await registry().getChannel();

    expect(channel?.streamerInfo).toBe("для разбора");
    expect(channel?.agentStreamerInfo).toBe("для ассистента");
  });

  test("подключение канала не затирает ни одно из полей", async () => {
    const store = stubRegistry({
      login: "channel",
      streamerInfo: "для разбора",
      agentStreamerInfo: "для ассистента",
    });

    await registry().setChannel({
      twitchUserId: "42",
      login: "channel",
      displayName: "Канал",
      watchFrom: 1,
      addedAt: 2,
    });

    expect(store.get("channel")?.get("streamerInfo")).toBe("для разбора");
    expect(store.get("channel")?.get("agentStreamerInfo")).toBe("для ассистента");
  });

  test("пустая строка сохраняется как осознанное «не задано»", async () => {
    const store = stubRegistry({ login: "channel", agentStreamerInfo: "было" });

    await registry().setAgentStreamerInfo("");

    expect(store.get("channel")?.get("agentStreamerInfo")).toBe("");
  });
});
