import { test, expect, describe } from "bun:test";
import { selectNextVideo } from "../../src/worker/schedule.ts";
import { MAX_ATTEMPTS, type StreamRecord } from "../../src/shared/registry.ts";
import type { TwitchVideo } from "../../src/shared/twitch.ts";

function video(vodId: string, publishedAtUnix: number): TwitchVideo {
  return {
    vodId,
    title: `Стрим ${vodId}`,
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: new Date(publishedAtUnix * 1000).toISOString(),
    publishedAtUnix,
    durationSeconds: 3600,
    viewable: "public",
    mutedSegments: [],
  };
}

function record(vodId: string, status: StreamRecord["status"], overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
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
    expect(next?.vodId).toBe("1");
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
    expect(selectNextVideo(videos, known, 1800000000, NOW)?.vodId).toBe("1");
  });

  test("failed берётся снова, пока не исчерпаны попытки", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "failed", { attempts: MAX_ATTEMPTS - 1 })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)?.vodId).toBe("1");
  });

  test("failed с исчерпанными попытками не берётся", () => {
    const videos = [video("1", 1900000000)];
    const known = new Map([["1", record("1", "failed", { attempts: MAX_ATTEMPTS })]]);
    expect(selectNextVideo(videos, known, 1800000000, NOW)).toBeUndefined();
  });

  test("из нескольких кандидатов берётся самая ранняя запись", () => {
    const videos = [video("2", 1950000000), video("1", 1900000000), video("3", 1980000000)];
    expect(selectNextVideo(videos, new Map(), 1800000000, NOW)?.vodId).toBe("1");
  });

  test("без кандидатов возвращается undefined — отсутствие новых записей не ошибка", () => {
    expect(selectNextVideo([], new Map(), 1800000000, NOW)).toBeUndefined();
  });
});
