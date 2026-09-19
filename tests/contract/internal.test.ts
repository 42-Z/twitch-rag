import { test, expect, describe, afterEach } from "vitest";
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
