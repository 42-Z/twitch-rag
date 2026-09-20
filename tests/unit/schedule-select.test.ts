import { test, expect, describe } from "vitest";
import { selectNextVideo, retireExhausted, runScheduledCheck, knownVideoIds } from "../../src/worker/schedule.ts";
import { MAX_ATTEMPTS, type StreamRecord } from "../../src/shared/registry.ts";
import type { TwitchVideo } from "../../src/shared/twitch.ts";

function video(vodId: string, publishedAtUnix: number, streamId = `stream-${vodId}`): TwitchVideo {
  return {
    vodId,
    title: `Стрим ${vodId}`,
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: new Date(publishedAtUnix * 1000).toISOString(),
    publishedAtUnix,
    durationSeconds: 3600,
    streamId,
    viewable: "public",
    mutedSegments: [],
  };
}

function record(vodId: string, status: StreamRecord["status"], overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    streamId: vodId,
    vodId,
    status,
    title: `Стрим ${vodId}`,
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: "2026-01-01T00:00:00Z",
    publishedAtUnix: 1767225600,
    durationSeconds: 3600,
    categories: [],
    source: "auto",
    attempts: 0,
    ...overrides,
  };
}

const NOW = 2000000000;

describe("отбор записи к автоматическому разбору", () => {
  test("новая запись после подключения канала берётся", () => {
    const videos = [video("1", 1900000000)];
    const next = selectNextVideo(videos, new Map(), 1800000000, NOW);
    expect(next?.video.vodId).toBe("1");
  });

  test("запись раньше подключения канала не берётся автоматически (FR-003)", () => {
    const videos = [video("1", 1000000000)];
    const next = selectNextVideo(videos, new Map(), 1800000000, NOW);
    expect(next).toBeUndefined();
  });

  test("уже разобранная запись пропускается — не берётся заново", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "ready")]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)).toBeUndefined();
  });

  test("пропущенная запись не берётся повторно (FR-006)", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "skipped", { reason: "только для подписчиков" })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)).toBeUndefined();
  });

  test("свежая processing не берётся — разбор ещё идёт", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "processing", { processedAt: NOW - 60 })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)).toBeUndefined();
  });

  test("брошенная processing (дольше суток) берётся заново (FR-034)", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "processing", { processedAt: NOW - 25 * 60 * 60 })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)?.video.vodId).toBe("1");
  });

  test("failed берётся снова, пока не исчерпаны попытки", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "failed", { attempts: MAX_ATTEMPTS - 1 })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)?.video.vodId).toBe("1");
  });

  test("failed с исчерпанными попытками не берётся", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "failed", { attempts: MAX_ATTEMPTS })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)).toBeUndefined();
  });

  test("из нескольких кандидатов берётся самая ранняя запись", () => {
    const videos = [video("2", 1950000000), video("1", 1900000000), video("3", 1980000000)];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW)?.video.vodId).toBe("1");
  });

  test("без кандидатов возвращается undefined — отсутствие новых записей не ошибка", () => {
    expect(selectNextVideo([], new Map(), 1800000000, NOW)).toBeUndefined();
  });
});

describe("запись идущего эфира", () => {
  // Площадка заводит запись архива в первые секунды трансляции, и та растёт
  // до её конца. Взять такую запись — значит разобрать обрывок и навсегда
  // закрыть себе остаток эфира: помеченная разобранной, она больше не
  // рассматривается.
  test("растущая запись идущего эфира не берётся", () => {
    const videos = [video("1", 1900000000, "эфир-сейчас")];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW, "эфир-сейчас")).toBeUndefined();
  });

  test("запись законченного эфира берётся, пока идёт другой", () => {
    const videos = [video("1", 1900000000, "эфир-прошлый")];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW, "эфир-сейчас")?.video.vodId).toBe("1");
  });

  test("из растущей и законченной берётся законченная", () => {
    const videos = [video("2", 1950000000, "эфир-сейчас"), video("1", 1900000000, "эфир-прошлый")];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW, "эфир-сейчас")?.video.vodId).toBe("1");
  });

  test("канал не в эфире — берётся самая свежая запись", () => {
    const videos = [video("1", 1900000000, "эфир-прошлый")];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW, undefined)?.video.vodId).toBe("1");
  });
});

describe("отбор части длинного эфира", () => {
  const H = 3600;
  /** Эфир длительностью в часы; по умолчанию — 7 часов, то есть две части. */
  const long = (vodId: string, publishedAtUnix: number, hours = 7): TwitchVideo => ({
    ...video(vodId, publishedAtUnix),
    durationSeconds: hours * H,
  });
  const part = (vodId: string, index: number, status: StreamRecord["status"], overrides: Partial<StreamRecord> = {}) =>
    record(vodId, status, { streamId: `${vodId}-p${index}`, part: index, partCount: 2, ...overrides });
  const known = (...records: StreamRecord[]) => new Map(records.map((item) => [item.streamId, item]));

  test("эфир длиннее порога без записей берётся первой частью", () => {
    const next = selectNextVideo([long("1", 1900000000)], new Map(), 1800000000, NOW);
    expect(next?.video.vodId).toBe("1");
    expect(next?.part).toMatchObject({ index: 1, count: 2, startSeconds: 0 });
  });

  test("первая часть разобрана — берётся вторая", () => {
    const next = selectNextVideo([long("1", 1900000000)], known(part("1", 1, "ready")), 1800000000, NOW);
    expect(next?.part).toMatchObject({ index: 2, count: 2 });
    expect(next?.part.startSeconds).toBe(Math.floor((7 * H) / 2));
  });

  test("обе части разобраны — брать нечего", () => {
    const both = known(part("1", 1, "ready"), part("1", 2, "ready"));
    expect(selectNextVideo([long("1", 1900000000)], both, 1800000000, NOW)).toBeUndefined();
  });

  test("неделёная запись эфира, ставшего делимым, автоматикой не трогается (FR-015)", () => {
    for (const status of ["ready", "failed", "processing", "skipped"] as const) {
      const legacy = known(record("1", status, { attempts: 1, processedAt: NOW }));
      expect(selectNextVideo([long("1", 1900000000)], legacy, 1800000000, NOW)).toBeUndefined();
    }
  });

  test("эфир ровно в шесть часов — одна запись без суффикса", () => {
    const next = selectNextVideo([long("1", 1900000000, 6)], new Map(), 1800000000, NOW);
    expect(next?.part).toMatchObject({ index: 1, count: 1, startSeconds: 0, endSeconds: 6 * H });
  });

  test("из двух эфиров раньше берётся тот, чья часть начинается раньше", () => {
    // Вторая часть старого эфира начинается через 3,5 часа после его начала —
    // раньше, чем начнётся следующий эфир.
    const older = long("1", 1900000000);
    const newer = long("2", 1900000000 + 5 * H);
    const next = selectNextVideo([newer, older], known(part("1", 1, "ready")), 1800000000, NOW);
    expect(next?.video.vodId).toBe("1");
    expect(next?.part.index).toBe(2);
  });

  test("правило подключения канала смотрит на эфир, а не на часть", () => {
    // Эфир начался до подключения, вторая часть — после: автоматически не берётся.
    const before = long("1", 1800000000 - H);
    expect(selectNextVideo([before], new Map(), 1800000000, NOW)).toBeUndefined();
  });

  test("идущий эфир не берётся", () => {
    const live = { ...long("1", 1900000000), streamId: "эфир-сейчас" };
    expect(selectNextVideo([live], new Map(), 1800000000, NOW, "эфир-сейчас")).toBeUndefined();
  });

  test("сорвавшаяся часть берётся снова, пока есть попытки", () => {
    const retry = known(part("1", 1, "ready"), part("1", 2, "failed", { attempts: MAX_ATTEMPTS - 1 }));
    expect(selectNextVideo([long("1", 1900000000)], retry, 1800000000, NOW)?.part.index).toBe(2);
    const spent = known(part("1", 1, "ready"), part("1", 2, "failed", { attempts: MAX_ATTEMPTS }));
    expect(selectNextVideo([long("1", 1900000000)], spent, 1800000000, NOW)).toBeUndefined();
  });

  test("номера записей площадки собираются и по частям, и по целым записям", () => {
    const all = known(part("1", 1, "ready"), part("1", 2, "ready"), record("2", "ready"));
    expect([...knownVideoIds(all)].sort()).toEqual(["1", "2"]);
  });
});

describe("исчерпавшие попытки", () => {
  function record(overrides: Partial<StreamRecord>): StreamRecord {
    return {
      streamId: "1",
      vodId: "1",
      status: "failed",
      title: "Эфир",
      url: "https://www.twitch.tv/videos/1",
      publishedAt: "2026-03-14T18:03:00Z",
      publishedAtUnix: 1773511380,
      durationSeconds: 3600,
      categories: [],
      source: "auto",
      attempts: 1,
      ...overrides,
    };
  }

  test("после трёх попыток запись становится пропущенной с причиной", async () => {
    // Модель данных требует именно пропуска: иначе запись навсегда висит
    // «неудачной» — владелец видит недоделку, а сводка знаний не считает её.
    const patched: Array<{ vodId: string; patch: Record<string, unknown> }> = [];
    const known = new Map<string, StreamRecord>([
      ["1", record({ streamId: "1", vodId: "1", status: "failed", attempts: MAX_ATTEMPTS, reason: "сервис недоступен" })],
    ]);
    const services = {
      registry: {
        patchStream: async (vodId: string, patch: Record<string, unknown>) => {
          patched.push({ vodId, patch });
        },
      },
    } as unknown as Parameters<typeof retireExhausted>[1];

    await retireExhausted(known, services);

    expect(patched[0]?.patch["status"]).toBe("skipped");
    expect(known.get("1")?.status).toBe("skipped");
  });

  test("прежняя причина не переносится в пропуск — она обещала повтор", async () => {
    // Пока запись в отказе, её берут заново, и причина об этом и говорит.
    // После перевода в пропущенные это уже неправда: автоматика к такой
    // записи не вернётся, и оставленная причина обманывала бы владельца.
    const patched: Record<string, unknown>[] = [];
    const known = new Map<string, StreamRecord>([
      [
        "1",
        record({
          streamId: "1",
          vodId: "1",
          status: "failed",
          attempts: MAX_ATTEMPTS,
          reason: "Разбор не удался. Запись попробуют разобрать заново.",
        }),
      ],
    ]);
    const services = {
      registry: {
        patchStream: async (_vodId: string, patch: Record<string, unknown>) => {
          patched.push(patch);
        },
      },
    } as unknown as Parameters<typeof retireExhausted>[1];

    await retireExhausted(known, services);

    const reason = String(patched[0]?.["reason"]);
    expect(reason).not.toContain("Запись попробуют разобрать заново");
    expect(reason).toContain("вручную");
  });

  test("недоисчерпанные и уже готовые не трогаются", async () => {
    const patched: unknown[] = [];
    const known = new Map<string, StreamRecord>([
      ["1", record({ streamId: "1", vodId: "1", status: "failed", attempts: MAX_ATTEMPTS - 1 })],
      ["2", record({ streamId: "2", vodId: "2", status: "ready", attempts: 9 })],
    ]);
    const services = {
      registry: {
        patchStream: async (...args: unknown[]) => {
          patched.push(args);
        },
      },
    } as unknown as Parameters<typeof retireExhausted>[1];

    await retireExhausted(known, services);

    expect(patched).toHaveLength(0);
    expect(known.get("1")?.status).toBe("failed");
  });
});

describe("сбой опроса", () => {
  /** Отметка о проверке читается публичным токеном — туда идёт своя фраза. */
  test("причина сбоя в реестр не пишется", async () => {
    const checks: Array<Record<string, unknown>> = [];
    const services = {
      registry: {
        getChannel: async () => ({
          twitchUserId: "1",
          login: "channel",
          displayName: "Канал",
          watchFrom: 0,
          addedAt: 0,
        }),
        knownStreamIds: async () => [],
        getStream: async () => undefined,
        recordCheck: async (mark: Record<string, unknown>) => {
          checks.push(mark);
        },
      },
      twitch: {
        listArchive: async () => {
          throw new Error("Twitch ответил 503: service unavailable");
        },
        getLiveStreamId: async () => undefined,
      },
    } as unknown as Parameters<typeof runScheduledCheck>[0];

    await runScheduledCheck(services, "https://example.workers.dev");

    const error = String(checks[0]?.["error"] ?? "");
    expect(error).not.toContain("503");
    expect(error).toBe("Проверка новых записей не удалась. Следующая будет через час.");
  });
});
