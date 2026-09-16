import { test, expect, describe } from "bun:test";
import { handleAddStream, handleDeleteStream, requireAdminToken } from "../../src/worker/routes/streams.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Env, Services } from "../../src/worker/env.ts";
import type { StreamRecord } from "../../src/shared/registry.ts";

/**
 * Контракт проверяется без сети: площадка и хранилища — простые заглушки,
 * форма ответа и защита токеном — то, что действительно принадлежит этому слою.
 */
const ADMIN_TOKEN = "test-admin-token";

function envWith(overrides: Partial<Env> = {}): Env {
  return { APP_ADMIN_TOKEN: ADMIN_TOKEN, ...overrides } as Env;
}

function servicesWith(options: {
  existing?: StreamRecord;
  video?: { title: string; url: string; publishedAt: string; publishedAtUnix: number; durationSeconds: number; viewable: string; mutedSegments: never[] };
} = {}): { services: Services; puts: unknown[]; boxCalls: unknown[]; deletedChunks: number } {
  const puts: unknown[] = [];
  const boxCalls: unknown[] = [];
  let deletedChunks = 0;
  const services = {
    registry: {
      getStream: async () => options.existing,
      putStream: async (record: unknown) => {
        puts.push(record);
      },
      removeStream: async () => undefined,
    },
    knowledge: {
      removeStream: async () => {
        deletedChunks = 137;
        return deletedChunks;
      },
    },
    documents: { remove: async () => undefined },
    twitch: {
      getVideo: async () =>
        options.video ?? {
          vodId: "2345678901",
          title: "Пятничный разбор кода",
          url: "https://www.twitch.tv/videos/2345678901",
          publishedAt: "2026-03-14T18:03:00Z",
          publishedAtUnix: 1773511380,
          durationSeconds: 3600,
          viewable: "public",
          mutedSegments: [],
        },
    },
    // Бокс — единственный внешний сервис, вызываемый только на этом пути;
    // без заглушки тест ушёл бы в реальную сеть.
    box: {
      startIngest: async (input: unknown) => {
        boxCalls.push(input);
      },
    },
  } as unknown as Services;
  return { services, puts, boxCalls, get deletedChunks() { return deletedChunks; } };
}

function request(body: unknown, token = ADMIN_TOKEN): Request {
  return new Request("https://x/api/streams", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("защита токеном владельца", () => {
  test("отказ без заголовка", () => {
    const req = new Request("https://x/api/streams", { method: "POST" });
    expect(() => requireAdminToken(req, envWith())).toThrow(AppError);
  });

  test("отказ с неверным токеном", () => {
    const req = request({ vodId: "1" }, "wrong-token");
    expect(() => requireAdminToken(req, envWith())).toThrow(AppError);
  });

  test("верный токен проходит", () => {
    expect(() => requireAdminToken(request({ vodId: "1" }), envWith())).not.toThrow();
  });
});

describe("POST /api/streams — ручное добавление", () => {
  test("новая запись принимается в обработку с кодом 202", async () => {
    const { services, puts, boxCalls } = servicesWith();
    const response = await handleAddStream(
      request({ url: "https://www.twitch.tv/videos/2345678901" }),
      envWith(),
      services,
      "https://worker.example",
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { vodId: string; status: string };
    expect(body.vodId).toBe("2345678901");
    expect(body.status).toBe("processing");
    expect(puts).toHaveLength(1);
    expect(boxCalls).toHaveLength(1);
  });

  test("уже разобранная запись отвергается кодом already_processed", async () => {
    const { services } = servicesWith({
      existing: {
        vodId: "2345678901",
        status: "ready",
        title: "т",
        url: "у",
        publishedAt: "2026-01-01T00:00:00Z",
        publishedAtUnix: 1,
        durationSeconds: 1,
        categories: [],
        source: "manual",
        attempts: 1,
      },
    });

    try {
      await handleAddStream(request({ vodId: "2345678901" }), envWith(), services, "https://worker.example");
      throw new Error("ожидалась ошибка already_processed");
    } catch (error) {
      expect((error as AppError).code).toBe("already_processed");
    }
  });

  test("без токена владельца запрос отвергается", async () => {
    const { services } = servicesWith();
    try {
      await handleAddStream(
        new Request("https://x/api/streams", { method: "POST", body: JSON.stringify({ vodId: "1" }) }),
        envWith(),
        services,
        "https://worker.example",
      );
      throw new Error("ожидалась ошибка unauthorized");
    } catch (error) {
      expect((error as AppError).code).toBe("unauthorized");
    }
  });
});

describe("DELETE /api/streams/:vodId", () => {
  test("ответ содержит число удалённых кусков", async () => {
    const { services } = servicesWith();
    const response = await handleDeleteStream(
      "2345678901",
      new Request("https://x", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      envWith(),
      services,
    );

    const body = (await response.json()) as { vodId: string; deletedChunks: number };
    expect(body.vodId).toBe("2345678901");
    expect(body.deletedChunks).toBe(137);
  });

  test("запись в разборе удалить нельзя — разбор продолжил бы писать", async () => {
    // Иначе удаление молча отменяется живым прогоном, а повторное добавление
    // поднимает второй разбор, и два разбора стирают разделы друг друга.
    const cutoff = Math.floor(Date.now() / 1000);
    const { services } = servicesWith({
      existing: {
        vodId: "2345678901",
        status: "processing",
        title: "Пятничный разбор кода",
        url: "https://www.twitch.tv/videos/2345678901",
        publishedAt: "2026-03-14T18:03:00Z",
        publishedAtUnix: cutoff,
        durationSeconds: 3600,
        categories: [],
        source: "manual",
        attempts: 1,
        processedAt: cutoff,
      },
    });

    try {
      await handleDeleteStream(
        "2345678901",
        new Request("https://x", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
        envWith(),
        services,
      );
      throw new Error("ожидалась ошибка busy");
    } catch (error) {
      expect((error as AppError).code).toBe("busy");
    }
  });

  test("брошенную запись в processing удалить можно", async () => {
    // Разбор, застрявший больше суток, считается брошенным: держать его
    // вечно нельзя, иначе запись не убрать никогда.
    const stale = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    const { services } = servicesWith({
      existing: {
        vodId: "2345678901",
        status: "processing",
        title: "Пятничный разбор кода",
        url: "https://www.twitch.tv/videos/2345678901",
        publishedAt: "2026-03-14T18:03:00Z",
        publishedAtUnix: stale,
        durationSeconds: 3600,
        categories: [],
        source: "manual",
        attempts: 1,
        processedAt: stale,
      },
    });

    const response = await handleDeleteStream(
      "2345678901",
      new Request("https://x", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      envWith(),
      services,
    );
    expect(response.status).toBe(200);
  });

  test("без токена владельца — отказ, удаление не выполняется", async () => {
    const { services } = servicesWith();
    try {
      await handleDeleteStream("2345678901", new Request("https://x"), envWith(), services);
      throw new Error("ожидалась ошибка unauthorized");
    } catch (error) {
      expect((error as AppError).code).toBe("unauthorized");
    }
  });
});
