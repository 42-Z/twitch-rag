import { test, expect, describe } from "bun:test";
import {
  handleAddStream,
  handleDeleteStream,
  handleReparseStream,
  startStreamIngest,
} from "../../src/worker/routes/streams.ts";
import { requireAdminToken } from "../../src/worker/routes/owner.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Env, Services } from "../../src/worker/env.ts";
import { MAX_ATTEMPTS, type StreamRecord } from "../../src/shared/registry.ts";

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
  /** Запись занята: хранилище отказало в занятии. */
  busyClaim?: boolean;
} = {}): {
  services: Services;
  puts: unknown[];
  boxCalls: unknown[];
  claims: number;
  deletedChunks: number;
} {
  const puts: unknown[] = [];
  const boxCalls: unknown[] = [];
  let claims = 0;
  let deletedChunks = 0;
  const services = {
    registry: {
      getStream: async () => options.existing,
      // Занятие записи: заглушка по умолчанию отдаёт её запуску. Проверки,
      // которым нужен отказ, задают busyClaim.
      claimForIngest: async () => {
        claims++;
        return options.busyClaim !== true;
      },
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
  return {
    services,
    puts,
    boxCalls,
    get claims() {
      return claims;
    },
    get deletedChunks() {
      return deletedChunks;
    },
  };
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

/** Запись в том или ином состоянии разбора; время начала разбора задаётся отдельно. */
function streamRecord(overrides: Partial<StreamRecord>): StreamRecord {
  return {
    vodId: "2345678901",
    status: "processing",
    title: "Пятничный разбор кода",
    url: "https://www.twitch.tv/videos/2345678901",
    publishedAt: "2026-01-01T00:00:00Z",
    publishedAtUnix: 1,
    durationSeconds: 3600,
    categories: [],
    source: "auto",
    attempts: 1,
    ...overrides,
  };
}

describe("повторный запуск разбора одной записи", () => {
  // Второй конвейер по той же записи пишет куски в ту же папку бокса, что и
  // первый: однажды так и случилось, и оба разбора испортили друг другу
  // работу. Проверки у вызывающих есть, но защита обязана стоять и в самом
  // запуске — иначе её обойдёт любой новый путь.
  const NOW = Math.floor(Date.now() / 1000);

  test("пока разбор идёт, второй не запускается и запись не переписывается", async () => {
    const { services, puts, boxCalls } = servicesWith({
      existing: streamRecord({ processedAt: NOW - 60 }),
    });

    const response = await handleAddStream(
      request({ vodId: "2345678901" }),
      envWith(),
      services,
      "https://worker.example",
    );

    expect(response.status).toBe(202);
    expect(boxCalls).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  test("брошенный разбор (дольше суток) не мешает запустить заново", async () => {
    const { services, boxCalls } = servicesWith({
      existing: streamRecord({ processedAt: NOW - 25 * 60 * 60 }),
    });

    await handleAddStream(request({ vodId: "2345678901" }), envWith(), services, "https://worker.example");

    expect(boxCalls).toHaveLength(1);
  });

  test("запуск отвергает занятую запись сам, а не полагается на вызывающих", async () => {
    const { services, boxCalls } = servicesWith({
      existing: streamRecord({ processedAt: NOW - 60 }),
    });

    try {
      await startStreamIngest("2345678901", "auto", services, "https://worker.example");
      throw new Error("ожидалась ошибка busy");
    } catch (error) {
      expect((error as AppError).code).toBe("busy");
    }
    expect(boxCalls).toHaveLength(0);
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

/** Запись, которую разбирать нечего: обрывок неудавшегося запуска эфира. */
const SHORT_VIDEO = {
  title: "РАССКАЗЫВАЮ ИСТОРИИ",
  url: "https://www.twitch.tv/videos/2345678901",
  publishedAt: "2026-07-27T12:00:00Z",
  publishedAtUnix: 1785153600,
  durationSeconds: 16,
  viewable: "public",
  mutedSegments: [] as never[],
};

describe("короткая запись", () => {
  const SHORT_REASON = "Запись короче трёх минут — разбирать в ней нечего.";

  test("в разбор не берётся: записи не занимаются, бокс не зовётся", async () => {
    const { services, puts, boxCalls, claims } = servicesWith({ video: SHORT_VIDEO });

    await handleAddStream(request({ vodId: "2345678901" }), envWith(), services, "https://worker.example");

    expect(claims).toBe(0);
    expect(boxCalls).toHaveLength(0);
    const record = puts[0] as { status: string; reason?: string };
    expect(record.status).toBe("skipped");
    expect(record.reason).toBe(SHORT_REASON);
  });

  test("добавление отвечает пропуском, а не начатым разбором (FR-005)", async () => {
    const { services } = servicesWith({ video: SHORT_VIDEO });

    const response = await handleAddStream(
      request({ vodId: "2345678901" }),
      envWith(),
      services,
      "https://worker.example",
    );

    // Код ответа, а не только поле status: клиент, не читающий тело, иначе
    // счёл бы пропуск начатой работой.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { vodId: string; status: string; reason?: string };
    expect(body.vodId).toBe("2345678901");
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe(SHORT_REASON);
  });

  test("причина в ответе та же, что записана в реестр", async () => {
    const { services, puts } = servicesWith({ video: SHORT_VIDEO });

    const response = await handleAddStream(
      request({ vodId: "2345678901" }),
      envWith(),
      services,
      "https://worker.example",
    );

    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe((puts[0] as { reason?: string }).reason);
  });

  test("повторный разбор отвечает так же", async () => {
    const { services } = servicesWith({
      existing: streamRecord({ status: "skipped", reason: "прежняя причина" }),
      video: SHORT_VIDEO,
    });

    const response = await handleReparseStream(
      "2345678901",
      new Request("https://x", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      envWith(),
      services,
      "https://worker.example",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe(SHORT_REASON);
  });

  test("через запуск разбора проходит тот же отказ — правило одно на все пути", async () => {
    const { services, boxCalls, claims } = servicesWith({ video: SHORT_VIDEO });

    await startStreamIngest("2345678901", "auto", services, "https://worker.example");

    expect(claims).toBe(0);
    expect(boxCalls).toHaveLength(0);
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

describe("POST /api/streams/:vodId/reparse", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const reparseRequest = (token = ADMIN_TOKEN): Request =>
    new Request("https://x/api/streams/2345678901/reparse", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

  test("разобранная трансляция уходит в разбор заново", async () => {
    const { services, puts, boxCalls } = servicesWith({
      existing: streamRecord({ status: "ready", processedAt: NOW - 3600 }),
    });

    const response = await handleReparseStream(
      "2345678901",
      reparseRequest(),
      envWith(),
      services,
      "https://worker.example",
    );

    expect(response.status).toBe(202);
    expect(boxCalls).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect((puts[0] as { status: string }).status).toBe("processing");
  });

  test("идущий разбор отвергается с понятной причиной", async () => {
    const { services, boxCalls } = servicesWith({
      existing: streamRecord({ processedAt: NOW - 60 }),
    });

    try {
      await handleReparseStream("2345678901", reparseRequest(), envWith(), services, "https://worker.example");
      throw new Error("ожидалась ошибка reparse_running");
    } catch (error) {
      expect((error as AppError).code).toBe("reparse_running");
      expect((error as AppError).status).toBe(409);
    }
    expect(boxCalls).toHaveLength(0);
  });

  test("неизвестная трансляция — not_found", async () => {
    const { services, boxCalls } = servicesWith();

    try {
      await handleReparseStream("2345678901", reparseRequest(), envWith(), services, "https://worker.example");
      throw new Error("ожидалась ошибка not_found");
    } catch (error) {
      expect((error as AppError).code).toBe("not_found");
    }
    expect(boxCalls).toHaveLength(0);
  });

  test("запись, занятая другим запуском, не запускается второй раз", async () => {
    // Занятие решается хранилищем одним действием: проверка выше читает
    // запись отдельно от записи, и между ними второй запуск успел бы
    // проскочить. Здесь запись свежая, то есть проверка выше её пропускает,
    // а занятие — нет; так и выглядит гонка со стороны проигравшего.
    const { services, puts, boxCalls } = servicesWith({
      existing: streamRecord({ status: "failed" }),
      busyClaim: true,
    });

    try {
      await handleReparseStream("2345678901", reparseRequest(), envWith(), services, "https://worker.example");
      throw new Error("ожидалась ошибка busy");
    } catch (error) {
      expect((error as AppError).code).toBe("busy");
      expect((error as AppError).status).toBe(409);
    }
    expect(boxCalls).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  test("без токена владельца повтор не запускается", async () => {
    const { services, boxCalls } = servicesWith({
      existing: streamRecord({ status: "ready", processedAt: NOW - 3600 }),
    });

    try {
      await handleReparseStream(
        "2345678901",
        reparseRequest("wrong-token"),
        envWith(),
        services,
        "https://worker.example",
      );
      throw new Error("ожидалась ошибка unauthorized");
    } catch (error) {
      expect((error as AppError).code).toBe("unauthorized");
    }
    expect(boxCalls).toHaveLength(0);
  });

  test("неудачный повтор не достаётся автоматике", async () => {
    // Повтор — явное действие владельца: если он не удался, автоповтор не
    // нужен. Иначе почасовой опрос качал бы и распознавал эфир заново без
    // спроса, а счёт попыток у записи уже был исчерпан первым разбором.
    const { services, puts } = servicesWith({
      existing: streamRecord({ status: "ready", attempts: 1, processedAt: NOW - 3600 }),
    });

    await handleReparseStream("2345678901", reparseRequest(), envWith(), services, "https://worker.example");

    expect((puts[0] as { attempts: number }).attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
  });
});
