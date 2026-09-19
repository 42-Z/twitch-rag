import { test, expect, describe } from "vitest";
import { MIN_STREAM_SECONDS, skipReason, type TwitchVideo } from "../../src/shared/twitch.ts";

/**
 * Правило «почему запись не берём» — одно на все пути запуска разбора
 * (FR-007). Ошибка в нём стоит дорого: слишком высокий порог выбрасывает
 * настоящие эфиры, слишком низкий — пускает в разбор обрывки.
 */

function video(durationSeconds: number, overrides: Partial<TwitchVideo> = {}): TwitchVideo {
  return {
    vodId: "2345678901",
    title: "Стрим",
    url: "https://www.twitch.tv/videos/2345678901",
    publishedAt: "2026-09-19T12:00:00Z",
    publishedAtUnix: 1789819200,
    durationSeconds,
    streamId: "stream-1",
    viewable: "public",
    mutedSegments: [],
    ...overrides,
  };
}

const SHORT = "Запись короче трёх минут — разбирать в ней нечего.";

describe("порог длительности", () => {
  test("запись в 179 секунд не берётся", () => {
    expect(skipReason(video(179))).toBe(SHORT);
  });

  test("запись ровно в 180 секунд берётся — граница включающая (FR-006)", () => {
    expect(skipReason(video(180))).toBeUndefined();
  });

  test("запись в 181 секунду берётся", () => {
    expect(skipReason(video(181))).toBeUndefined();
  });

  test("обрывок в 16 секунд не берётся", () => {
    expect(skipReason(video(16))).toBe(SHORT);
  });

  test("нулевая длительность даёт ту же причину, что и обрывок (FR-003)", () => {
    expect(skipReason(video(0))).toBe(SHORT);
  });

  test("часовой эфир берётся", () => {
    expect(skipReason(video(3600))).toBeUndefined();
  });
});

describe("прочие причины пропуска", () => {
  test("запись, доступная не всем зрителям, сохраняет свою причину", () => {
    // Порядок причин важен: короткая запись подписчиков — редкость, но если
    // причина подменится, владелец прочитает не то, что случилось.
    expect(skipReason(video(16, { viewable: "subscriber" }))).toBe(
      "Запись закрыта: доступна не всем зрителям.",
    );
  });

  test("длинная запись подписчиков тоже не берётся, и причина та же", () => {
    expect(skipReason(video(7200, { viewable: "subscriber" }))).toBe(
      "Запись закрыта: доступна не всем зрителям.",
    );
  });
});

describe("порог объявлен один раз", () => {
  test("граница берётся из постоянной, а не из числа в условии", () => {
    expect(MIN_STREAM_SECONDS).toBe(180);
    expect(skipReason(video(MIN_STREAM_SECONDS))).toBeUndefined();
    expect(skipReason(video(MIN_STREAM_SECONDS - 1))).toBe(SHORT);
  });
});
