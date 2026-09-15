import { test, expect, describe } from "bun:test";
import {
  parseTwitchDuration,
  toTwitchTimecode,
  vodUrlAt,
  formatClock,
  parseClock,
  shiftSegments,
  mergeTranscripts,
} from "../../src/shared/time.ts";

describe("длительность записи Twitch", () => {
  test("разбирает полную форму", () => {
    expect(parseTwitchDuration("7h12m35s")).toBe(7 * 3600 + 12 * 60 + 35);
  });

  test("разбирает формы с пропущенными частями", () => {
    expect(parseTwitchDuration("45m")).toBe(2700);
    expect(parseTwitchDuration("12s")).toBe(12);
    expect(parseTwitchDuration("1h30s")).toBe(3630);
    expect(parseTwitchDuration("2h")).toBe(7200);
  });

  test("отказывается разбирать мусор вместо того, чтобы вернуть ноль", () => {
    expect(() => parseTwitchDuration("позавчера")).toThrow();
    expect(() => parseTwitchDuration("")).toThrow();
  });
});

describe("ссылка на момент записи", () => {
  test("собирает таймкод", () => {
    expect(toTwitchTimecode(4350)).toBe("1h12m30s");
    expect(toTwitchTimecode(59)).toBe("0h0m59s");
  });

  test("ссылка совпадает с форматом из контракта", () => {
    expect(vodUrlAt("2345678901", 4350)).toBe("https://www.twitch.tv/videos/2345678901?t=1h12m30s");
  });

  test("отрицательное время не ломает ссылку", () => {
    expect(toTwitchTimecode(-5)).toBe("0h0m0s");
  });
});

describe("человекочитаемое время", () => {
  test("часы появляются только когда они есть", () => {
    expect(formatClock(4350)).toBe("1:12:30");
    expect(formatClock(750)).toBe("12:30");
  });

  test("разбор возвращает то же число", () => {
    expect(parseClock("1:12:30")).toBe(4350);
    expect(parseClock("12:30")).toBe(750);
  });

  test("мусор отвергается", () => {
    expect(() => parseClock("1:2:3:4")).toThrow();
    expect(() => parseClock("двенадцать")).toThrow();
  });
});

describe("приведение времени куска ко времени записи", () => {
  test("смещение прибавляется к обеим меткам", () => {
    const shifted = shiftSegments([{ start: 3, end: 9, text: "привет" }], 600);
    expect(shifted).toEqual([{ start: 603, end: 609, text: "привет" }]);
  });

  test("склейка выбрасывает фразу, повторённую в зоне перекрытия", () => {
    const first = [
      { start: 0, end: 5, text: "первая фраза" },
      { start: 595, end: 600, text: "фраза на стыке" },
    ];
    const second = [
      { start: 597, end: 601, text: "Фраза на стыке!" },
      { start: 601, end: 606, text: "вторая фраза" },
    ];
    const merged = mergeTranscripts([first, second]);
    expect(merged.map((segment) => segment.text)).toEqual([
      "первая фраза",
      "фраза на стыке",
      "вторая фраза",
    ]);
  });

  test("разные фразы в зоне перекрытия сохраняются обе", () => {
    const merged = mergeTranscripts([
      [{ start: 595, end: 600, text: "что-то одно" }],
      [{ start: 597, end: 602, text: "совсем другое" }],
    ]);
    expect(merged).toHaveLength(2);
  });
});
