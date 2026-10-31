import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { http, HttpResponse } from "msw";
import { describe, expect, test } from "vitest";
import worker from "../../src/worker/index.ts";
import { createMcpServer } from "../../src/worker/mcp.ts";
import { FakeRegistry, network, twitchVideo, TWITCH_HELIX_URL } from "./network.ts";

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

const BOX_URL = "https://us-east-1.box.upstash.com";
const BOX_ID = "box-id";

/** Бокс: принимает запуск разбора и запоминает команду, которую ему передали. */
function boxHandlers(commands: string[]) {
  return [
    http.get(`${BOX_URL}/v2/box/${BOX_ID}`, () => HttpResponse.json({ id: BOX_ID })),
    http.post(`${BOX_URL}/v2/box/${BOX_ID}/exec`, async ({ request }) => {
      const body = (await request.json()) as { command: string[] };
      commands.push(body.command.join(" "));
      return HttpResponse.json({ exit_code: 0, output: "" });
    }),
  ];
}

/** Канал с записями: имя документа есть, поэтому именование молчит. */
function seededRegistry(count: number, status: (index: number) => string = () => "ready"): FakeRegistry {
  const registry = new FakeRegistry();
  registry.data.set(
    "channel",
    new Map([
      ["twitchUserId", "42"],
      ["login", "channel"],
      ["displayName", "Канал"],
      ["watchFrom", "0"],
      ["addedAt", "0"],
    ]),
  );
  const index = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const id = `2345678${100 + i}`;
    registry.data.set(
      `stream:${id}`,
      new Map([
        ["vodId", id],
        ["status", status(i)],
        ["title", `Эфир ${i}`],
        ["docTitle", `Документ ${i}`],
        ["url", `https://www.twitch.tv/videos/${id}`],
        ["publishedAt", "2026-08-01T18:00:00Z"],
        ["publishedAtUnix", String(1_780_000_000 + i)],
        ["durationSeconds", "7200"],
        ["categories", "[]"],
        ["source", "auto"],
        ["attempts", "1"],
      ]),
    );
    index.set(id, 1_780_000_000 + i);
  }
  registry.data.set("streams:index", index);
  return registry;
}

describe("часовая проверка при выросшем реестре", () => {
  /**
   * Проверка идёт целиком, в среде Worker'а: реестр, площадка и бокс подменены
   * сетью, привязки настоящие. Смысл — в двух числах сразу: новый эфир уходит
   * в разбор, и обращений к реестру на вызов немного, хотя записей сорок.
   *
   * До правки чтение шло по обращению на запись: 40 записей — 41 обращение
   * только на реестр, а с остальным вызов упирался в предел в 50 внешних
   * обращений и падал, не запустив разбор
   * (specs/009-batch-registry-read/research.md §1).
   */
  test("новый эфир уходит в разбор, а реестр читается пачкой", async () => {
    const registry = seededRegistry(40);
    const boxCommands: string[] = [];
    network.use(
      ...registry.handlers(),
      ...twitchVideo({ id: "2345678999", duration: "2h" }),
      http.get(`${TWITCH_HELIX_URL}/streams`, () => HttpResponse.json({ data: [] })),
      ...boxHandlers(boxCommands),
    );

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(boxCommands).toHaveLength(1);
    expect(boxCommands[0]).toContain("2345678999");
    expect(registry.hash("stream:2345678999").get("status")).toBe("processing");
    // Все сорок записей прочитаны одной пачкой, а не сорока запросами. Одиночные
    // команды SDK тоже шлёт путём пакета — пачкой из одной команды, — поэтому
    // смотрим на пачки длиннее одной.
    expect(registry.pipelines.filter((size) => size > 1)).toEqual([40]);
    // Одиннадцать обращений на весь вызов: канал, список, пачка записей, три
    // прочтения токена площадки с его записью в кэш, чтение записи перед
    // разбором, занятие, сохранение и отметка о проверке. Было — 41 только на
    // чтение реестра, и вызов не укладывался в предел в 50 обращений.
    expect(registry.requests).toBe(11);
  });
});

describe("сводка знаний при выросшем реестре", () => {
  /**
   * Сводка считается по всем записям реестра, поэтому читает его целиком.
   * Проверка сторожит то же, что и часовая: число обращений растёт пачками, а
   * не вместе с реестром. Кэш в подставном реестре пуст, так что каждый запрос
   * считается заново.
   */
  test("одна запись — сводка считается", async () => {
    const registry = seededRegistry(1);
    network.use(...registry.handlers());

    const response = await exports.default.fetch("https://worker.test/api/knowledge/stats");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { channel: string | null; streams: { ready: number; skipped: number } };
    expect(body.channel).toBe("channel");
    expect(body.streams).toEqual({ ready: 1, skipped: 0 });
    // Кэш сводки (чтение), канал, список, пачка записей и запись кэша.
    expect(registry.requests).toBe(5);
  });

  test("четыреста записей — обращения выросли только пачками", async () => {
    const registry = seededRegistry(400, (index) => (index < 100 ? "skipped" : "ready"));
    network.use(...registry.handlers());

    const response = await exports.default.fetch("https://worker.test/api/knowledge/stats");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { streams: { ready: number; skipped: number } };
    expect(body.streams).toEqual({ ready: 300, skipped: 100 });
    // Те же пять обращений и четыре пачки вместо одной: к реестру прибавились
    // три запроса, а не триста девяносто девять.
    expect(registry.requests).toBe(8);
  });
});

describe("перечень для ассистента при выросшем реестре", () => {
  /**
   * Инструмент ассистента берёт записи из реестра, а не из векторного поиска,
   * и читает его целиком. Клиент подключается к самому серверу, без сети:
   * проверяется путь инструмента — разбор входа, чтение, ответ, — а не
   * транспорт, который живёт отдельно.
   */
  test("пятьдесят записей читаются двумя обращениями, в ответе пятьдесят строк", async () => {
    const registry = seededRegistry(60);
    network.use(...registry.handlers());

    const server = createMcpServer(env);
    const [toServer, toClient] = InMemoryTransport.createLinkedPair();
    await server.connect(toServer);
    const client = new Client({ name: "проверка", version: "0" });
    await client.connect(toClient);

    const result = await client.callTool({ name: "list_streams", arguments: { limit: 50 } });
    await client.close();

    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text.split("\n")).toHaveLength(50);
    // Список записей и одна пачка на все пятьдесят: обращение к реестру не
    // растёт вместе с числом строк ответа.
    expect(registry.requests).toBe(2);
  });
});
