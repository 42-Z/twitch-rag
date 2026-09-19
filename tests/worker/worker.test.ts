import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import worker from "../../src/worker/index.ts";
import { FakeRegistry, network, twitchVideo } from "./network.ts";

/**
 * Worker в своей среде исполнения: запрос идёт в сам Worker, привязки —
 * настоящие, из `wrangler.jsonc`.
 *
 * Прочие проверки вызывают обработчики напрямую с подставными службами и
 * не видят ни настройки, ни среды: испорченное имя привязки, забытый маршрут
 * или код, которого нет в изоляте, проходили бы их молча и всплывали бы
 * только после выпуска.
 */

const ADMIN = { authorization: "Bearer worker-test-admin", "content-type": "application/json" };

describe("пути сервиса", () => {
  test("признак жизни отвечает без токена и без обращений к сервисам", async () => {
    const response = await exports.default.fetch("https://worker.test/api/health");
    expect(response.status).toBe(200);
  });

  test("добавление записи без токена отвергается", async () => {
    const response = await exports.default.fetch("https://worker.test/api/streams", {
      method: "POST",
      body: JSON.stringify({ vodId: "2345678901" }),
    });
    expect(response.status).toBe(401);
  });

  test("короткая запись не уходит в разбор, а отмечается пропущенной с причиной", async () => {
    const registry = new FakeRegistry();
    network.use(...registry.handlers(), ...twitchVideo({ id: "2345678901", duration: "2m10s" }));

    const response = await exports.default.fetch("https://worker.test/api/streams", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ vodId: "2345678901" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason: string };
    expect(body.status).toBe("skipped");
    expect(body.reason).toContain("короче трёх минут");
    expect(registry.hash("stream:2345678901").get("status")).toBe("skipped");
  });

  test("незнакомый путь — ответ «нет такого пути», а не падение", async () => {
    const response = await exports.default.fetch("https://worker.test/api/nowhere");
    expect(response.status).toBe(404);
  });
});

describe("привязки платформы", () => {
  test("часовой запуск без канала ничего не трогает, а свежие куски аудио не убирает", async () => {
    const registry = new FakeRegistry();
    network.use(...registry.handlers());
    await env.AUDIO.put("audio/2345678901/000.m4a", "кусок");

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.AUDIO.head("audio/2345678901/000.m4a")).not.toBeNull();
  });

  test("ограничитель частоты публичных путей подключён и ограничивает", async () => {
    const limiter = env.PUBLIC_RATE_LIMITER;
    expect(limiter).toBeDefined();
    const outcomes: boolean[] = [];
    for (let i = 0; i < 31; i++) outcomes.push((await limiter!.limit({ key: "проверка" })).success);
    expect(outcomes.slice(0, 30).every(Boolean)).toBe(true);
    expect(outcomes[30]).toBe(false);
  });

  test("разбор записи подключён как Workflow", () => {
    expect(typeof env.INGEST?.create).toBe("function");
  });
});
