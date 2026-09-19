import { test, expect, describe } from "bun:test";
import { runScheduledCheck, unprocessableToSkip } from "../../src/worker/schedule.ts";
import type { StreamRecord } from "../../src/shared/registry.ts";
import type { TwitchVideo } from "../../src/shared/twitch.ts";

/**
 * Проход пометки: записи, которые разбирать нечего, помечаются пропущенными
 * до выбора записи к разбору. Проверяется и отбор, и то, что запуск разбора
 * после него достаётся настоящему эфиру.
 */

const WATCH_FROM = 1800000000;
const NOW = 1900000000;
const SHORT = "Запись короче трёх минут — разбирать в ней нечего.";

function video(vodId: string, durationSeconds: number, overrides: Partial<TwitchVideo> = {}): TwitchVideo {
  return {
    vodId,
    title: `Стрим ${vodId}`,
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: new Date(WATCH_FROM * 1000).toISOString(),
    publishedAtUnix: WATCH_FROM + 3600,
    durationSeconds,
    streamId: `stream-${vodId}`,
    viewable: "public",
    mutedSegments: [],
    ...overrides,
  };
}

const known = (entries: Array<[string, Partial<StreamRecord>]> = []): Map<string, StreamRecord> =>
  new Map(
    entries.map(([vodId, overrides]) => [
      vodId,
      {
        vodId,
        status: "ready" as const,
        title: `Стрим ${vodId}`,
        url: `https://www.twitch.tv/videos/${vodId}`,
        publishedAt: "2026-09-01T00:00:00Z",
        publishedAtUnix: WATCH_FROM + 1000,
        durationSeconds: 3600,
        categories: [],
        source: "auto" as const,
        attempts: 1,
        ...overrides,
      },
    ]),
  );

describe("отбор записей под пометку", () => {
  test("обрывок после подключения канала помечается", () => {
    const picked = unprocessableToSkip([video("1", 16)], new Map(), WATCH_FROM);
    expect(picked.map((v) => v.vodId)).toEqual(["1"]);
  });

  test("обрывок раньше подключения канала не помечается (FR-003)", () => {
    const old = video("1", 16, { publishedAtUnix: WATCH_FROM - 3600 });
    expect(unprocessableToSkip([old], new Map(), WATCH_FROM)).toEqual([]);
  });

  test("растущая запись идущего эфира не помечается", () => {
    // Она тоже короче трёх минут в первые минуты эфира. Пометить её
    // пропущенной — потерять весь эфир: второй раз автоматика её не возьмёт.
    const live = video("1", 40);
    expect(unprocessableToSkip([live], new Map(), WATCH_FROM, live.streamId)).toEqual([]);
  });

  test("запись законченного эфира берётся, пока идёт другой", () => {
    const live = video("2", 40);
    const finished = video("1", 16);
    const picked = unprocessableToSkip([live, finished], new Map(), WATCH_FROM, live.streamId);
    expect(picked.map((v) => v.vodId)).toEqual(["1"]);
  });

  test("известная запись не помечается повторно", () => {
    const existing = known([["1", { status: "skipped", reason: SHORT }]]);
    expect(unprocessableToSkip([video("1", 16)], existing, WATCH_FROM)).toEqual([]);
  });

  test("настоящая запись под пометку не попадает", () => {
    expect(unprocessableToSkip([video("1", 3600)], new Map(), WATCH_FROM)).toEqual([]);
  });

  test("запись, доступная не всем зрителям, помечается наравне с обрывком", () => {
    const closed = video("1", 3600, { viewable: "subscriber" });
    expect(unprocessableToSkip([closed], new Map(), WATCH_FROM).map((v) => v.vodId)).toEqual(["1"]);
  });
});

/** Заглушки хранилищ и площадки: проверка идёт без сети. */
function servicesWith(videos: TwitchVideo[], options: { liveStreamId?: string } = {}) {
  const puts: StreamRecord[] = [];
  const boxCalls: string[] = [];
  const services = {
    registry: {
      getChannel: async () => ({
        twitchUserId: "42",
        login: "channel",
        displayName: "Канал",
        watchFrom: WATCH_FROM,
        addedAt: WATCH_FROM,
      }),
      knownVodIds: async () => [],
      getStream: async () => undefined,
      patchStream: async () => undefined,
      putStream: async (record: StreamRecord) => {
        puts.push(record);
      },
      claimForIngest: async () => true,
      recordCheck: async () => undefined,
    },
    twitch: {
      listArchive: async () => videos,
      getLiveStreamId: async () => options.liveStreamId,
      getVideo: async (vodId: string) => videos.find((v) => v.vodId === vodId)!,
    },
    box: {
      startIngest: async (input: { vodId: string }) => {
        boxCalls.push(input.vodId);
      },
    },
    documents: {},
    knowledge: {},
    models: {},
  } as unknown as Parameters<typeof runScheduledCheck>[0];
  return { services, puts, boxCalls };
}

describe("часовая проверка при обрывке в архиве", () => {
  test("обрывок помечается пропущенным, а разбор достаётся настоящей записи", async () => {
    const stub = video("1", 16);
    const real = video("2", 7200);
    const { services, puts, boxCalls } = servicesWith([stub, real]);

    await runScheduledCheck(services, "https://example.test");

    const skipped = puts.filter((record) => record.status === "skipped");
    expect(skipped.map((record) => record.vodId)).toEqual(["1"]);
    expect(skipped[0]?.reason).toBe(SHORT);
    expect(boxCalls).toEqual(["2"]);
  });

  test("обрывок не отнимает запуск: разбор идёт, даже если обрывок самый ранний", async () => {
    // Обрывок раньше настоящей записи — тот случай, ради которого проход и
    // появился: без него проверка потратила бы час на обрывок.
    const stub = video("1", 16, { publishedAtUnix: WATCH_FROM + 60 });
    const real = video("2", 7200, { publishedAtUnix: WATCH_FROM + 120 });
    const { services, boxCalls } = servicesWith([stub, real]);

    await runScheduledCheck(services, "https://example.test");

    expect(boxCalls).toEqual(["2"]);
  });

  test("растущая запись идущего эфира не помечается и не разбирается", async () => {
    const live = video("1", 40);
    const { services, puts, boxCalls } = servicesWith([live], { liveStreamId: live.streamId });

    await runScheduledCheck(services, "https://example.test");

    expect(puts).toEqual([]);
    expect(boxCalls).toEqual([]);
  });
});
