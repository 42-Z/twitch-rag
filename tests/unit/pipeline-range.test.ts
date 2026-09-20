import { test, expect, describe } from "vitest";
import { parseArgs } from "../../src/pipeline/args.ts";
import { clipChapters } from "../../src/pipeline/media.ts";
import { absoluteChunks, formatSection } from "../../src/pipeline/segment.ts";

/**
 * Часть эфира — отрезок записи: конвейер качает только его, а время в сигнале
 * обязан отдать абсолютным, от начала эфира. Ошибка здесь не падает — она
 * сдвигает все ссылки на момент эфира на длину предыдущих частей.
 */
describe("главы на отрезке", () => {
  const chapters = [
    { title: "Разговоры", startSeconds: 0, endSeconds: 10000 },
    { title: "Игра", startSeconds: 10000, endSeconds: 30000 },
  ];

  test("глава, начавшаяся до отрезка, начинается на его границе; время остаётся абсолютным", () => {
    expect(clipChapters(chapters, 21600, 43200)).toEqual([{ title: "Игра", startSeconds: 21600, endSeconds: 30000 }]);
  });

  test("глава внутри отрезка не меняется, вне отрезка — отбрасывается", () => {
    expect(clipChapters(chapters, 0, 10000)).toEqual([{ title: "Разговоры", startSeconds: 0, endSeconds: 10000 }]);
  });

  test("нет ни одной главы на отрезке — одна пустая на весь отрезок", () => {
    expect(clipChapters(chapters, 40000, 50000)).toEqual([{ title: "", startSeconds: 40000, endSeconds: 50000 }]);
  });
});

describe("смещения кусков", () => {
  test("начало отрезка прибавляется к смещению каждого куска", () => {
    const chunks = [
      { index: 0, file: "a", offsetSeconds: 0, durationSeconds: 1200 },
      { index: 1, file: "b", offsetSeconds: 1200, durationSeconds: 600 },
    ];
    expect(absoluteChunks(chunks, 21600).map((chunk) => chunk.offsetSeconds)).toEqual([21600, 22800]);
    expect(absoluteChunks(chunks, 21600).map((chunk) => chunk.durationSeconds)).toEqual([1200, 600]);
    expect(absoluteChunks(chunks, 0)).toEqual(chunks);
  });
});

describe("аргумент отрезка для yt-dlp", () => {
  test("часы, минуты и секунды, как в замере", () => {
    expect(formatSection(3600, 3600 + 32 * 60)).toBe("*01:00:00-01:32:00");
    expect(formatSection(0, 21600)).toBe("*00:00:00-06:00:00");
    expect(formatSection(21600, 43201)).toBe("*06:00:00-12:00:01");
  });
});

describe("аргументы запуска", () => {
  const base = ["--url", "https://www.twitch.tv/videos/1", "--callback", "https://x/hook"];

  test("новый вид: идентификатор части и границы отрезка", () => {
    expect(parseArgs(["--stream", "1-p2", "--from", "21600", "--to", "43200", ...base])).toEqual({
      streamId: "1-p2",
      vodId: "1",
      url: "https://www.twitch.tv/videos/1",
      callbackUrl: "https://x/hook",
      fromSeconds: 21600,
      toSeconds: 43200,
    });
  });

  test("прежний вид принимается: --vod читается как --stream, границ нет", () => {
    const args = parseArgs(["--vod", "2345678901", ...base]);
    expect(args.streamId).toBe("2345678901");
    expect(args.vodId).toBe("2345678901");
    expect(args.fromSeconds).toBeUndefined();
    expect(args.toSeconds).toBeUndefined();
  });

  test("подстановка в идентификаторе, нецелые и перевёрнутые границы отвергаются", () => {
    expect(() => parseArgs(["--stream", "1;rm -rf /", ...base])).toThrow();
    expect(() => parseArgs(["--stream", "1-p0", ...base])).toThrow();
    expect(() => parseArgs(["--stream", "1", "--from", "5", "--to", "5", ...base])).toThrow();
    expect(() => parseArgs(["--stream", "1", "--from", "1.5", ...base])).toThrow();
    expect(() => parseArgs(["--stream", "1", "--from", "-1", ...base])).toThrow();
    expect(() => parseArgs(["--url", "u", "--callback", "c"])).toThrow();
  });
});
