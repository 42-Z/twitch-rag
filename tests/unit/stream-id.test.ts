import { test, expect, describe } from "vitest";
import { AppError } from "../../src/shared/errors.ts";
import { formatStreamId, isStreamId, parseStreamId, STREAM_ID_PATTERN } from "../../src/shared/stream-id.ts";

/**
 * Идентификатор записи уходит в командную оболочку бокса, в имя объекта
 * хранилища и в префикс удаления векторов, поэтому проверяется строго и
 * до любого обращения к сети.
 */
describe("идентификатор записи", () => {
  test("неделёная запись — просто номер записи площадки", () => {
    expect(parseStreamId("2878430068")).toEqual({ vodId: "2878430068" });
    expect("part" in parseStreamId("2878430068")).toBe(false);
  });

  test("часть разбирается на номер записи и номер части", () => {
    expect(parseStreamId("2878430068-p2")).toEqual({ vodId: "2878430068", part: 2 });
    expect(parseStreamId("1-p999")).toEqual({ vodId: "1", part: 999 });
  });

  test("сборка и разбор обратимы", () => {
    expect(formatStreamId("2878430068")).toBe("2878430068");
    expect(formatStreamId("2878430068", 3)).toBe("2878430068-p3");
    expect(parseStreamId(formatStreamId("2878430068", 3))).toEqual({ vodId: "2878430068", part: 3 });
  });

  test.each([
    "",
    "abc",
    "123-p",
    "123-p0",
    "123-p00",
    "123-p1000",
    "../123",
    "123/p2",
    "123-p2-p3",
    "123:4",
    "123-P2",
    " 123",
    "1".repeat(21),
    "123\n",
  ])("не по образцу отвергается: %j", (value) => {
    expect(isStreamId(value)).toBe(false);
    expect(() => parseStreamId(value)).toThrow(AppError);
    try {
      parseStreamId(value);
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
  });

  test("сборка отвергает часть меньше единицы и нецелую", () => {
    expect(() => formatStreamId("123", 0)).toThrow(AppError);
    expect(() => formatStreamId("123", -1)).toThrow(AppError);
    expect(() => formatStreamId("123", 1.5)).toThrow(AppError);
  });

  test("имя прогона разбора укладывается в правила Workflows", () => {
    // Документация Workflows: образец имени и не больше 100 знаков.
    const longest = `${"9".repeat(20)}-p999`;
    expect(STREAM_ID_PATTERN.test(longest)).toBe(true);
    const instance = `ingest-${longest}-${"a".repeat(64)}`;
    expect(instance.length).toBeLessThanOrEqual(100);
    expect(instance).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
  });
});
