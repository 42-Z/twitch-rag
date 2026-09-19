import { test, expect, describe } from "vitest";
import { publishedAtOf } from "../../src/pipeline/media.ts";

describe("дата эфира из метаданных записи", () => {
  test("берётся из timestamp", () => {
    expect(publishedAtOf({ timestamp: 1789317174 })).toBe("2026-09-13T16:32:54.000Z");
  });

  test("при отсутствии timestamp — из upload_date, началом суток", () => {
    expect(publishedAtOf({ upload_date: "20260913" })).toBe("2026-09-13T00:00:00.000Z");
  });

  test("timestamp важнее upload_date: в нём есть время суток", () => {
    expect(publishedAtOf({ timestamp: 1789317174, upload_date: "20260913" })).toBe("2026-09-13T16:32:54.000Z");
  });

  test("без даты — отказ, а не подстановка текущего времени", () => {
    expect(() => publishedAtOf({})).toThrow();
    expect(() => publishedAtOf({ upload_date: "вчера" })).toThrow();
  });
});
