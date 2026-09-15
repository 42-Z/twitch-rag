import { test, expect, describe } from "bun:test";
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
    },
  } as unknown as Env;
}

function fakeServices(): Services {
  return {
    registry: {
      getStream: async () => undefined,
      putStream: async () => undefined,
      patchStream: async () => undefined,
    },
  } as unknown as Services;
}

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
