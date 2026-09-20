import { test, expect, describe } from "vitest";
import {
  handleAddStream,
  handleDeleteStream,
  handleReparseStream,
} from "../../src/worker/routes/streams.ts";
import type { Env, Services } from "../../src/worker/env.ts";
import type { StreamRecord } from "../../src/shared/registry.ts";

/**
 * Операции владельца на составных идентификаторах — без сети, на заглушках с
 * памятью: нужно видеть, кого именно затронул запуск, повторный разбор и удаление.
 */
const TOKEN = "test-admin-token";
const H = 3600;
const NOW = Math.floor(Date.now() / 1000);
const BASE = "https://worker.example";

const env = { APP_ADMIN_TOKEN: TOKEN } as Env;

function video(hours: number) {
  return {
    vodId: "1",
    title: "эфир",
    url: "https://www.twitch.tv/videos/1",
    publishedAt: "2026-09-13T10:00:00Z",
    publishedAtUnix: 1789293600,
    durationSeconds: hours * H,
    streamId: "s",
    viewable: "public",
    mutedSegments: [] as never[],
  };
}

function record(streamId: string, status: StreamRecord["status"], overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    streamId,
    vodId: "1",
    status,
    title: "эфир",
    url: "https://www.twitch.tv/videos/1",
    publishedAt: "2026-09-13T10:00:00Z",
    publishedAtUnix: 1789293600,
    durationSeconds: 3600,
    categories: [],
    source: "manual",
    attempts: 1,
    processedAt: NOW - 100,
    ...overrides,
  };
}

function world(hours: number, records: StreamRecord[] = []) {
  const store = new Map(records.map((item) => [item.streamId, item]));
  const calls = {
    put: [] as StreamRecord[],
    box: [] as Array<{ streamId: string; fromSeconds: number; toSeconds: number }>,
    removedChunks: [] as string[],
    removedDocs: [] as string[],
    removedRecords: [] as string[],
  };
  const services = {
    registry: {
      getStream: async (id: string) => store.get(id),
      claimForIngest: async () => true,
      putStream: async (item: StreamRecord) => {
        calls.put.push(item);
        store.set(item.streamId, item);
      },
      patchStream: async () => undefined,
      removeStream: async (id: string) => {
        calls.removedRecords.push(id);
        store.delete(id);
      },
    },
    twitch: { getVideo: async () => video(hours) },
    box: {
      startIngest: async (input: { streamId: string; fromSeconds: number; toSeconds: number }) => {
        calls.box.push(input);
      },
    },
    knowledge: {
      removeStream: async (id: string) => {
        calls.removedChunks.push(id);
        return 5;
      },
    },
    documents: {
      remove: async (id: string) => {
        calls.removedDocs.push(id);
      },
    },
  } as unknown as Services;
  return { services, calls };
}

const authed = (init: RequestInit & { body?: string } = {}): Request =>
  new Request("https://x/api/streams", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...init,
  });

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("повторный разбор части", () => {
  test("разбирается только эта часть, на своём отрезке", async () => {
    const { services, calls } = world(9, [record("1-p1", "ready", { part: 1, partCount: 2 }), record("1-p2", "ready", { part: 2, partCount: 2 })]);

    const response = await handleReparseStream("1-p2", authed(), env, services, BASE);

    expect(response.status).toBe(202);
    expect(calls.box).toEqual([{ streamId: "1-p2", fromSeconds: 16200, toSeconds: 32400, url: expect.any(String), callbackUrl: expect.any(String) }]);
    expect(calls.put.map((item) => item.streamId)).toEqual(["1-p2"]);
    expect(calls.put[0]).toMatchObject({ part: 2, partCount: 2, partStartSeconds: 16200, durationSeconds: 16200 });
    expect(await json(response)).toMatchObject({ streamId: "1-p2", vodId: "1", part: 2, partCount: 2 });
    // Время части — время эфира плюс её начало.
    expect(calls.put[0]?.publishedAtUnix).toBe(1789293600 + 16200);
  });

  test("вторая часть идёт уже разбираемой — повторный запуск отвергается", async () => {
    const { services, calls } = world(9, [record("1-p2", "processing", { part: 2, partCount: 2 })]);

    await expect(handleReparseStream("1-p2", authed(), env, services, BASE)).rejects.toMatchObject({
      code: "reparse_running",
    });
    expect(calls.box).toHaveLength(0);
  });

  test("часть с номером больше числа частей и часть у неделимого эфира отвергаются", async () => {
    const long = world(9, [record("1-p5", "failed"), record("1-p2", "failed")]);
    await expect(handleReparseStream("1-p5", authed(), env, long.services, BASE)).rejects.toMatchObject({
      code: "invalid_input",
    });
    const short = world(3, [record("1-p2", "failed")]);
    await expect(handleReparseStream("1-p2", authed(), env, short.services, BASE)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(long.calls.box.length + short.calls.box.length).toBe(0);
  });

  test("неделёная запись у теперь делимого эфира: запускается первая часть, прежняя запись убирается", async () => {
    const { services, calls } = world(9, [record("1", "failed")]);

    const response = await handleReparseStream("1", authed(), env, services, BASE);

    expect(response.status).toBe(202);
    expect(calls.box.map((item) => item.streamId)).toEqual(["1-p1"]);
    expect(calls.removedChunks).toEqual(["1"]);
    expect(calls.removedDocs).toEqual(["1"]);
    expect(calls.removedRecords).toEqual(["1"]);
    // Части не задеты: прежняя запись убрана по её ключу, а не по префиксу части.
    expect(calls.removedChunks).not.toContain("1-p1");
  });
});

describe("удаление части", () => {
  test("уносит векторы, документ и запись только этой части", async () => {
    const { services, calls } = world(9, [record("1-p1", "ready"), record("1-p2", "ready")]);

    const response = await handleDeleteStream("1-p2", authed({ method: "DELETE" }), env, services);

    expect(await json(response)).toMatchObject({ streamId: "1-p2", vodId: "1", deletedChunks: 5 });
    expect(calls.removedChunks).toEqual(["1-p2"]);
    expect(calls.removedDocs).toEqual(["1-p2"]);
    expect(calls.removedRecords).toEqual(["1-p2"]);
  });

  test("идентификатор не по образцу отвергается до обращения к хранилищам", async () => {
    const { services, calls } = world(9);
    for (const bad of ["", "abc", "1-p0", "../1", "1:"]) {
      await expect(handleDeleteStream(bad, authed({ method: "DELETE" }), env, services)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(calls.removedChunks.length + calls.removedDocs.length + calls.removedRecords.length).toBe(0);
  });
});

describe("добавление эфира, который делится", () => {
  const add = () => authed({ body: JSON.stringify({ vodId: "1" }) });

  test("девять часов — ответ называет части, в работу берётся первая", async () => {
    const { services, calls } = world(9);

    const response = await handleAddStream(add(), env, services, BASE);

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ streamId: "1-p1", vodId: "1", part: 1, partCount: 2, status: "processing" });
    expect(calls.box.map((item) => [item.streamId, item.fromSeconds, item.toSeconds])).toEqual([["1-p1", 0, 16200]]);
  });

  test("первая часть разобрана — берётся вторая", async () => {
    const { services, calls } = world(9, [record("1-p1", "ready", { part: 1, partCount: 2 })]);

    const response = await handleAddStream(add(), env, services, BASE);

    expect(await json(response)).toMatchObject({ streamId: "1-p2", part: 2, partCount: 2 });
    expect(calls.box.map((item) => item.streamId)).toEqual(["1-p2"]);
  });

  test("обе части разобраны — already_processed", async () => {
    const { services, calls } = world(9, [record("1-p1", "ready"), record("1-p2", "ready")]);

    await expect(handleAddStream(add(), env, services, BASE)).rejects.toMatchObject({ code: "already_processed" });
    expect(calls.box).toHaveLength(0);
  });

  test("эфир ровно в шесть часов — одна запись без суффикса и без полей части", async () => {
    const { services, calls } = world(6);

    const response = await handleAddStream(add(), env, services, BASE);

    expect(await json(response)).toMatchObject({ streamId: "1", vodId: "1" });
    expect("part" in (await json(await handleAddStream(add(), env, world(6).services, BASE)))).toBe(false);
    expect(calls.box[0]).toMatchObject({ streamId: "1", fromSeconds: 0, toSeconds: 6 * H });
    expect("part" in (calls.put[0] ?? {})).toBe(false);
  });
});
