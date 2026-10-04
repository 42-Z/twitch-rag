import { test, expect, describe, afterEach, vi } from "vitest";
import { handleIngestReady, requireIngestSecret } from "../../src/worker/routes/internal.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Env, Services } from "../../src/worker/env.ts";

/**
 * Инстанс Workflow называется по записи и прогону, и `create` с занятым
 * именем бросает ошибку — эта заглушка воспроизводит ровно такое поведение,
 * чтобы поймать два регресса: дедупликация не может опираться на статус
 * реестра (он стоит в processing уже к моменту сигнала, его поставил
 * startStreamIngest), а новый прогон той же записи не должен упираться в имя
 * прошлого — оно занято навсегда.
 */
function fakeEnv(options: { existingInstanceIds?: Set<string>; failCreate?: Error } = {}): Env {
  const created = options.existingInstanceIds ?? new Set<string>();
  return {
    INGEST_SECRET: "shared-secret",
    INGEST: {
      create: async ({ id }: { id: string }) => {
        if (options.failCreate) throw options.failCreate;
        if (created.has(id)) throw new Error(`Instance ${id} already exists.`);
        created.add(id);
        return { id };
      },
      get: async (id: string) => {
        if (!created.has(id)) throw new Error(`Instance ${id} not found.`);
        return { id };
      },
    },
  } as unknown as Env;
}

interface Captured {
  patched: Array<{ vodId: string; patch: Record<string, unknown> }>;
  put: Array<Record<string, unknown>>;
}

function fakeServices(captured?: Captured): Services {
  return {
    registry: {
      getStream: async () => undefined,
      putStream: async (record: Record<string, unknown>) => {
        captured?.put.push(record);
      },
      patchStream: async (vodId: string, patch: Record<string, unknown>) => {
        captured?.patched.push({ vodId, patch });
      },
    },
    // Площадка отвечает про саму запись. По умолчанию запись на месте:
    // проверки, которым нужен приговор, задают videoGone.
    twitch: {
      getVideo: async (vodId: string) => {
        if (videoGone) throw new AppError("vod_unavailable", "Запись недоступна: она удалена или закрыта.");
        return { vodId, title: "Тест" };
      },
    },
  } as unknown as Services;
}

/** Запись пропала навсегда — так отвечает площадка. */
let videoGone = false;

afterEach(() => {
  videoGone = false;
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    vodId: "2873255697",
    runId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    title: "Тест",
    publishedAt: "2026-09-13T16:32:54Z",
    durationSeconds: 19019,
    categories: [],
    chunks: [{ index: 0, key: "audio/2873255697/chunk-0000.m4a", offsetSeconds: 0, durationSeconds: 600 }],
    ...overrides,
  };
}

function request(payload: unknown, secret = "shared-secret"): Request {
  return new Request("https://x/api/internal/ingest-ready", {
    method: "POST",
    headers: { "x-ingest-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("секрет прогона", () => {
  test("отказ без заголовка", () => {
    expect(() => requireIngestSecret(new Request("https://x"), fakeEnv())).toThrow(AppError);
  });
  test("отказ с неверным секретом", () => {
    expect(() => requireIngestSecret(request(body(), "wrong"), fakeEnv())).toThrow(AppError);
  });
  test("верный секрет проходит", () => {
    expect(() => requireIngestSecret(request(body()), fakeEnv())).not.toThrow();
  });
});

describe("POST /api/internal/ingest-ready", () => {
  test("первый сигнал создаёт инстанс Workflow с кодом 202", async () => {
    const response = await handleIngestReady(request(body()), fakeEnv(), fakeServices());

    expect(response.status).toBe(202);
    const data = (await response.json()) as { status: string; instanceId?: string };
    expect(data.status).toBe("processing");
    expect(data.instanceId).toBe("ingest-2873255697-3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  test("повторный сигнал той же записи не создаёт второй инстанс", async () => {
    const env = fakeEnv();
    const services = fakeServices();
    await handleIngestReady(request(body()), env, services);
    const second = await handleIngestReady(request(body()), env, services);

    expect(second.status).toBe(200);
    const data = (await second.json()) as { status: string };
    expect(data.status).toBe("processing");
  });

  test("повторный сигнал не возвращает готовую запись в обработку", async () => {
    // Запись реестра трогается только после успешного создания разбора:
    // иначе запоздалый повторный сигнал переводил бы `ready` обратно в
    // `processing`, и запись висела бы так до следующего опроса.
    const captured: Captured = { patched: [], put: [] };
    const env = fakeEnv();
    const services = fakeServices(captured);
    await handleIngestReady(request(body()), env, services);
    const writes = captured.put.length;

    await handleIngestReady(request(body()), env, services);

    expect(captured.put.length).toBe(writes);
  });

  test("настоящий сбой создания инстанса не маскируется под повтор", async () => {
    const env = fakeEnv({ failCreate: new Error("Internal error") });
    try {
      await handleIngestReady(request(body()), env, fakeServices());
      throw new Error("ожидалась ошибка upstream_unavailable");
    } catch (error) {
      expect((error as AppError).code).toBe("upstream_unavailable");
    }
  });

  test("новый прогон той же записи получает собственный инстанс", async () => {
    // Имя инстанса занято навсегда: без имени прогона повторный разбор
    // упирался бы в прошлый и молча не начинался.
    const env = fakeEnv();
    const services = fakeServices();
    const first = await handleIngestReady(request(body()), env, services);
    const second = await handleIngestReady(
      request(body({ runId: "8c0a1f22-1111-4c33-9d44-55667788aabb" })),
      env,
      services,
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const data = (await second.json()) as { instanceId?: string };
    expect(data.instanceId).toBe("ingest-2873255697-8c0a1f22-1111-4c33-9d44-55667788aabb");
  });

  test("сигнал без имени прогона отвергается", async () => {
    const payload = body();
    delete (payload as Record<string, unknown>).runId;
    try {
      await handleIngestReady(request(payload), fakeEnv(), fakeServices());
      throw new Error("ожидалась ошибка invalid_input");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
  });

  test("сигнал об отказе бокса помечает запись пропущенной", async () => {
    const response = await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "subscriber_only", message: "только для подписчиков" }),
      fakeEnv(),
      fakeServices(),
    );
    const data = (await response.json()) as { status: string };
    expect(data.status).toBe("skipped");
  });

  test("временный отказ бокса оставляет запись к повтору, а не пропускает навсегда", async () => {
    // Сбой скачивания — не приговор: пропуск снимает запись с работы
    // навсегда, а спецификация требует взять её позже.
    const captured: Captured = { patched: [], put: [] };
    await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "download_failed", message: "не удалось скачать" }),
      fakeEnv(),
      fakeServices(captured),
    );
    expect(captured.patched[0]?.patch["status"]).toBe("failed");
  });

  test("неизвестный код отказа считается временным", async () => {
    const captured: Captured = { patched: [], put: [] };
    await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "что-то новое", message: "непонятно" }),
      fakeEnv(),
      fakeServices(captured),
    );
    expect(captured.patched[0]?.patch["status"]).toBe("failed");
  });

  test("сообщение бокса в реестр не попадает — там своя фраза", async () => {
    // Реестр читается публичным токеном, то есть любую строку из него видит
    // любой посетитель страницы. Текст от бокса — сторона, которой мы не
    // распоряжаемся, — туда не пускается: владельцу достаётся своя фраза,
    // а присланное остаётся в журнале.
    const captured: Captured = { patched: [], put: [] };
    await handleIngestReady(
      request({
        vodId: "2873255697",
        failed: true,
        code: "download_failed",
        message: "yt-dlp: ERROR: unable to download video data: HTTP Error 403",
      }),
      fakeEnv(),
      fakeServices(captured),
    );

    const reason = String(captured.patched[0]?.patch["reason"]);
    expect(reason).not.toContain("yt-dlp");
    expect(reason).not.toContain("403");
    expect(reason).toBe("Запись не удалось скачать. Попробуем ещё раз.");
  });

  test("запоздавший отказ не помечает запись отказавшей", async () => {
    // Тот же заход уже начал разбор, а ответ на сигнал готовности до бокса не
    // дошёл — и следом пришёл отказ. Пометив запись отказавшей, мы отправили бы
    // её под автоматический повтор, и разбор пошёл бы второй раз (FR-029).
    const captured: Captured = { patched: [], put: [] };
    const runId = "7ba0d62c-a003-444b-8d92-b860ec1aa46c";

    const response = await handleIngestReady(
      request({ vodId: "2873255697", failed: true, runId, code: "download_failed", message: "не удалось скачать" }),
      fakeEnv({ existingInstanceIds: new Set([`ingest-2873255697-${runId}`]) }),
      fakeServices(captured),
    );

    const data = (await response.json()) as { status: string };
    expect(data.status).toBe("processing");
    expect(captured.patched).toHaveLength(0);
  });

  test("отказ захода, который не начинался, применяется как прежде", async () => {
    const captured: Captured = { patched: [], put: [] };

    await handleIngestReady(
      request({
        vodId: "2873255697",
        failed: true,
        runId: "7ba0d62c-a003-444b-8d92-b860ec1aa46c",
        code: "download_failed",
        message: "не удалось скачать",
      }),
      fakeEnv(),
      fakeServices(captured),
    );

    expect(captured.patched[0]?.patch["status"]).toBe("failed");
  });

  test("«не найдена», а площадка запись видит — оставляем к повтору", async () => {
    // yt-dlp говорит «not found» и про удалённую запись, и про минутную
    // заминку. Приговор по её словам терял бы целый эфир: так и случилось с
    // записью, которая через час скачалась без единой жалобы. Решает площадка.
    const captured: Captured = { patched: [], put: [] };

    await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "not_found", message: "Запись удалена или недоступна." }),
      fakeEnv(),
      fakeServices(captured),
    );

    expect(captured.patched[0]?.patch["status"]).toBe("failed");
  });

  test("«не найдена», и площадка её не видит — пропускаем навсегда", async () => {
    const captured: Captured = { patched: [], put: [] };
    videoGone = true;

    await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "not_found", message: "Запись удалена или недоступна." }),
      fakeEnv(),
      fakeServices(captured),
    );

    expect(captured.patched[0]?.patch["status"]).toBe("skipped");
  });

  test("незнакомый код отказа тоже получает свою фразу", async () => {
    const captured: Captured = { patched: [], put: [] };
    await handleIngestReady(
      request({ vodId: "2873255697", failed: true, code: "что-то новое", message: "стек: at Object.<anonymous>" }),
      fakeEnv(),
      fakeServices(captured),
    );

    expect(String(captured.patched[0]?.patch["reason"])).not.toContain("Object.<anonymous>");
  });

  test("сигнал бокса не начисляет вторую попытку", async () => {
    // Попытку зачёл запуск разбора; сигнал — это тот же заход.
    const captured: Captured = { patched: [], put: [] };
    await handleIngestReady(request(body()), fakeEnv(), fakeServices(captured));
    expect(captured.put[0]?.["attempts"]).toBe(1);
  });

  test("без секрета — отказ", async () => {
    const req = new Request("https://x", { method: "POST", body: JSON.stringify(body()) });
    try {
      await handleIngestReady(req, fakeEnv(), fakeServices());
      throw new Error("ожидалась ошибка invalid_input");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
  });
});

describe("сигнал готовности части эфира", () => {
  const VOD = "2873255697";
  const RUN = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const BROADCAST_START = "2026-09-13T16:32:54Z";
  const PART_START = 21600;

  function partBody(overrides: Record<string, unknown> = {}) {
    return body({
      streamId: `${VOD}-p2`,
      partStartSeconds: PART_START,
      durationSeconds: 10800,
      chunks: [
        { index: 0, key: `audio/${VOD}-p2/chunk-0000.m4a`, offsetSeconds: PART_START, durationSeconds: 1200 },
      ],
      ...overrides,
    });
  }

  /** Окружение, запоминающее задание, с которым создан разбор. */
  function capturingEnv(): { env: Env; created: Array<{ id: string; params: Record<string, unknown> }> } {
    const created: Array<{ id: string; params: Record<string, unknown> }> = [];
    const env = {
      INGEST_SECRET: "shared-secret",
      INGEST: {
        create: async (input: { id: string; params: Record<string, unknown> }) => {
          created.push(input);
          return { id: input.id };
        },
        get: async () => {
          throw new Error("not found");
        },
      },
    } as unknown as Env;
    return { env, created };
  }

  /** Запись части, которую положил запуск разбора: в ней и лежит общее число частей. */
  function servicesWithPartRecord(captured: Captured, exists = true): Services {
    return {
      registry: {
        getStream: async (id: string) =>
          exists && id === `${VOD}-p2`
            ? { streamId: id, vodId: VOD, part: 2, partCount: 3, partStartSeconds: PART_START, source: "auto", attempts: 1 }
            : undefined,
        putStream: async (record: Record<string, unknown>) => {
          captured.put.push(record);
        },
        patchStream: async () => undefined,
      },
    } as unknown as Services;
  }

  test("разбор называется по части, а задание несёт границы и время части", async () => {
    const { env, created } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };

    const response = await handleIngestReady(request(partBody()), env, servicesWithPartRecord(captured));

    expect(response.status).toBe(202);
    expect(created[0]?.id).toBe(`ingest-${VOD}-p2-${RUN}`);
    const partPublishedAt = new Date(Date.parse(BROADCAST_START) + PART_START * 1000).toISOString();
    expect(created[0]?.params).toMatchObject({
      streamId: `${VOD}-p2`,
      vodId: VOD,
      partStartSeconds: PART_START,
      part: { index: 2, count: 3 },
      publishedAt: partPublishedAt,
      durationSeconds: 10800,
    });
  });

  test("запись части в реестре: поля части и время начала части", async () => {
    const { env } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };

    await handleIngestReady(request(partBody()), env, servicesWithPartRecord(captured));

    const expectedUnix = Math.floor(Date.parse(BROADCAST_START) / 1000) + PART_START;
    expect(captured.put[0]).toMatchObject({
      streamId: `${VOD}-p2`,
      vodId: VOD,
      part: 2,
      partCount: 3,
      partStartSeconds: PART_START,
      publishedAtUnix: expectedUnix,
      durationSeconds: 10800,
    });
  });

  test("у неделёной записи полей части нет", async () => {
    const { env, created } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };

    await handleIngestReady(request(body()), env, servicesWithPartRecord(captured));

    expect(created[0]?.params["part"]).toBeUndefined();
    expect(created[0]?.params["partStartSeconds"]).toBe(0);
    expect("part" in (captured.put[0] ?? {})).toBe(false);
  });

  test("идентификатор, чей номер записи не совпал с vodId, отвергается", async () => {
    const { env } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };
    await expect(
      handleIngestReady(request(partBody({ streamId: "999-p2" })), env, servicesWithPartRecord(captured)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("идентификатор не по образцу отвергается", async () => {
    const { env } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };
    await expect(
      handleIngestReady(request(partBody({ streamId: `${VOD}-p0` })), env, servicesWithPartRecord(captured)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("часть, которой нет в реестре, отвергается", async () => {
    const { env, created } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };
    await expect(
      handleIngestReady(request(partBody()), env, servicesWithPartRecord(captured, false)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(created).toHaveLength(0);
  });

  test("отказ бокса по части помечает запись этой части", async () => {
    const { env } = capturingEnv();
    const captured: Captured = { patched: [], put: [] };
    const services = fakeServices(captured);
    await handleIngestReady(
      request({ vodId: VOD, streamId: `${VOD}-p2`, failed: true, code: "download_failed", message: "не удалось" }),
      env,
      services,
    );
    expect(captured.patched.map((item) => item.vodId)).toEqual([`${VOD}-p2`]);
  });
});

describe("кадры в сигнале готовности", () => {
  const VOD = "2873255697";
  const R2 = "acct.r2.cloudflarestorage.com";

  /** Подписанная ссылка так, как её отдаёт бокс: хост R2, путь кадров записи, подпись в запросе. */
  const link = (streamId: string, atSeconds: number, host = R2): string =>
    `https://${host}/twitch-audio/frames/${streamId}/frame-${String(atSeconds).padStart(6, "0")}.jpg` +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=21600&X-Amz-Signature=abc123";
  const own = (atSeconds: number, streamId = VOD) => ({ atSeconds, url: link(streamId, atSeconds) });

  function capture(): { env: Env; created: Array<{ id: string; params: Record<string, unknown> }> } {
    const created: Array<{ id: string; params: Record<string, unknown> }> = [];
    const env = {
      INGEST_SECRET: "shared-secret",
      INGEST: {
        create: async (input: { id: string; params: Record<string, unknown> }) => {
          created.push(input);
          return { id: input.id };
        },
        get: async () => {
          throw new Error("not found");
        },
      },
    } as unknown as Env;
    return { env, created };
  }

  /** Сигнал целой записи (0 … 19 019 с) с заданными кадрами; возвращает ответ и параметры разбора. */
  async function signal(frames: unknown, overrides: Record<string, unknown> = {}) {
    const { env, created } = capture();
    const payload = body({ ...(frames === undefined ? {} : { frames }), ...overrides });
    const response = await handleIngestReady(request(payload), env, fakeServices());
    return { response, params: created[0]?.params };
  }

  const framesOf = (params: Record<string, unknown> | undefined) =>
    params?.["frames"] as Array<{ atSeconds: number; url: string }> | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("сигнал прежнего вида, без поля кадров — разбор принят, поля frames в параметрах нет", async () => {
    const { response, params } = await signal(undefined);

    expect(response.status).toBe(202);
    expect(params).toBeDefined();
    expect("frames" in (params as object)).toBe(false);
  });

  test("пустой список кадров равен отсутствию поля", async () => {
    const { response, params } = await signal([]);

    expect(response.status).toBe(202);
    expect("frames" in (params as object)).toBe(false);
  });

  test("годные кадры доходят до параметров разбора как есть, по возрастанию времени", async () => {
    const { response, params } = await signal([own(360), own(0), own(180)]);

    expect(response.status).toBe(202);
    expect(framesOf(params)).toEqual([own(0), own(180), own(360)]);
  });

  test("из пяти кадров три негодных — остаются два, сигнал принят", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { response, params } = await signal([
      own(0),
      { atSeconds: 180, url: link(VOD, 180, "evil.example") },
      { atSeconds: 360, url: link(VOD, 360).replace("https:", "http:") },
      own(540, "9999999999"),
      own(720),
    ]);

    expect(response.status).toBe(202);
    expect(framesOf(params)?.map((frame) => frame.atSeconds)).toEqual([0, 720]);
  });

  test.each([
    ["чужой порт", `https://${R2}:8443/twitch-audio/frames/${VOD}/frame-000180.jpg?X-Amz-Signature=a`],
    ["хост только похож на R2", `https://evil-r2.cloudflarestorage.com/twitch-audio/frames/${VOD}/frame-000180.jpg`],
    ["R2 лишь в пути чужого хоста", `https://evil.example/r2.cloudflarestorage.com/frames/${VOD}/frame-000180.jpg`],
    ["R2 лишь в начале чужого хоста", `https://r2.cloudflarestorage.com.evil.example/frames/${VOD}/frame-000180.jpg`],
    ["выход из каталога записи через ..", `https://${R2}/twitch-audio/frames/${VOD}/../../frames/other/frame-000180.jpg`],
    ["каталог кадров другой записи", link("2873255698", 180)],
    ["не ссылка", "это не адрес"],
    ["схема не https", `ftp://${R2}/twitch-audio/frames/${VOD}/frame-000180.jpg`],
  ])("ссылка отброшена: %s", async (_case, url) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { response, params } = await signal([own(0), { atSeconds: 180, url }]);

    expect(response.status).toBe(202);
    expect(framesOf(params)).toEqual([own(0)]);
  });

  test.each([
    ["время не целое", { atSeconds: 1.5, url: link(VOD, 1) }],
    ["время отрицательное", { atSeconds: -180, url: link(VOD, 0) }],
    ["время строкой", { atSeconds: "180", url: link(VOD, 180) }],
    ["адреса нет", { atSeconds: 180 }],
    ["адрес пустой", { atSeconds: 180, url: "" }],
    ["адрес не строка", { atSeconds: 180, url: 42 }],
    ["адрес длиннее предела", { atSeconds: 180, url: `${link(VOD, 180)}&pad=${"x".repeat(1000)}` }],
    ["запись не объект", "кадр"],
    ["запись null", null],
  ])("запись отброшена: %s", async (_case, entry) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { response, params } = await signal([own(0), entry]);

    expect(response.status).toBe(202);
    expect(framesOf(params)).toEqual([own(0)]);
  });

  test("кадры вне отрезка записи отброшены: до начала, на конце и за ним", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Запись — 0 … 19 019 с; конец отрезка в него не входит.
    const { params } = await signal([own(0), own(19018), own(19019), own(30000)]);

    expect(framesOf(params)?.map((frame) => frame.atSeconds)).toEqual([0, 19018]);
  });

  test("у части эфира отрезок — от её начала, и кадры считаются в нём", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const part = `${VOD}-p2`;
    const created: Array<{ id: string; params: Record<string, unknown> }> = [];
    const env = {
      INGEST_SECRET: "shared-secret",
      INGEST: {
        create: async (input: { id: string; params: Record<string, unknown> }) => {
          created.push(input);
          return { id: input.id };
        },
        get: async () => {
          throw new Error("not found");
        },
      },
    } as unknown as Env;
    const services = {
      registry: {
        getStream: async (id: string) =>
          id === part
            ? { streamId: id, vodId: VOD, part: 2, partCount: 3, partStartSeconds: 21600, source: "auto", attempts: 1 }
            : undefined,
        putStream: async () => undefined,
        patchStream: async () => undefined,
      },
    } as unknown as Services;

    // Вторая часть — 21 600 … 32 400 с.
    const payload = body({
      streamId: part,
      partStartSeconds: 21600,
      durationSeconds: 10800,
      chunks: [{ index: 0, key: `audio/${part}/chunk-0000.m4a`, offsetSeconds: 21600, durationSeconds: 1200 }],
      frames: [own(18000, part), own(21600, part), own(32399, part), own(32400, part), own(21600, VOD)],
    });
    const response = await handleIngestReady(request(payload), env, services);

    expect(response.status).toBe(202);
    // 18 000 — до части, 32 400 — её конец, последний кадр лежит в каталоге целой записи, а не части.
    expect(framesOf(created[0]?.params)?.map((frame) => frame.atSeconds)).toEqual([21600, 32399]);
  });

  test("повтор той же секунды: остаётся первый кадр", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = { atSeconds: 180, url: link(VOD, 180) };
    const second = { atSeconds: 180, url: `${link(VOD, 180)}&second=1` };

    const { params } = await signal([first, second]);

    expect(framesOf(params)).toEqual([first]);
  });

  test("больше 400 записей — остаются первые 400 по времени, а не по порядку в сигнале", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 450 кадров по секунде, присланных в обратном порядке: по порядку в сигнале «первыми» были бы поздние.
    const reversed = Array.from({ length: 450 }, (_, index) => own(449 - index));

    const { response, params } = await signal(reversed);

    expect(response.status).toBe(202);
    const frames = framesOf(params) ?? [];
    expect(frames).toHaveLength(400);
    expect(frames[0]?.atSeconds).toBe(0);
    expect(frames[399]?.atSeconds).toBe(399);
  });

  test.each([["строка", "frames"], ["объект", { atSeconds: 0 }], ["число", 5], ["null", null]])(
    "поле кадров не массив (%s) — разбор принят без кадров",
    async (_case, value) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { response, params } = await signal(value);

      expect(response.status).toBe(202);
      expect("frames" in (params as object)).toBe(false);
    },
  );

  test("в журнал идёт число отброшенных кадров, а не их ссылки", async () => {
    // Ссылка с подписью — носитель доступа: журнал её не хранит.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await signal([own(0), { atSeconds: 180, url: link(VOD, 180, "evil.example") }]);

    const written = warn.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(written).toContain("кадров отброшено при приёме: 1");
    expect(written).not.toContain("evil.example");
    expect(written).not.toContain("X-Amz-Signature");
    expect(written).not.toContain(R2);
  });

  test("кадры сигнала не попадают в запись реестра", async () => {
    const { env } = capture();
    const captured: Captured = { patched: [], put: [] };

    await handleIngestReady(request(body({ frames: [own(0), own(180)] })), env, fakeServices(captured));

    expect(JSON.stringify(captured.put)).not.toContain("X-Amz-Signature");
    expect(captured.put.every((record) => !("frames" in record))).toBe(true);
  });
});
