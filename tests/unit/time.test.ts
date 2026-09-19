import { test, expect, describe } from "vitest";
import {
  parseTwitchDuration,
  toTwitchTimecode,
  vodUrlAt,
  formatClock,
  shiftSegments,
  mergeTranscripts,
  formatDuration,
  prevailingLanguage,
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
});

describe("длительность словами", () => {
  test("часы и минуты без лишнего нуля", () => {
    expect(formatDuration(19019)).toBe("5 ч 17 мин");
    expect(formatDuration(7200)).toBe("2 ч");
    expect(formatDuration(2400)).toBe("40 мин");
  });

  test("остаток считается от округлённых минут", () => {
    // 3591 с — это 59 мин 51 с: при округлении до минут выходит час, и
    // «60 мин» здесь было бы неправдой.
    expect(formatDuration(3591)).toBe("1 ч");
    // 7195 с — это 119 мин 55 с, то есть уже два часа, а не «1 ч 60 мин».
    expect(formatDuration(7195)).toBe("2 ч");
  });

  test("совсем короткое не превращается в ноль", () => {
    expect(formatDuration(20)).toBe("меньше минуты");
    expect(formatDuration(0)).toBe("меньше минуты");
  });
});

describe("приведение времени куска ко времени записи", () => {
  test("смещение прибавляется к обеим меткам", () => {
    const shifted = shiftSegments([{ start: 3, end: 9, text: "привет" }], 600);
    expect(shifted).toEqual([{ start: 603, end: 609, text: "привет" }]);
  });

  test("куски складываются подряд, порядок и текст сохраняются", () => {
    // Куски режутся встык, без наложения (segment.ts): склейка ничего не
    // выбрасывает. Тест сторожит именно это — прежде здесь проверялось
    // перекрытие, которого в конвейере не было.
    const first = [
      { start: 0, end: 5, text: "первая фраза" },
      { start: 595, end: 600, text: "фраза на стыке" },
    ];
    const second = [
      { start: 600, end: 604, text: "фраза на стыке" },
      { start: 604, end: 609, text: "вторая фраза" },
    ];
    expect(mergeTranscripts([first, second])).toEqual([...first, ...second]);
  });

  test("пустые куски не мешают", () => {
    expect(mergeTranscripts([[], [{ start: 0, end: 2, text: "речь" }], []])).toHaveLength(1);
  });
});

describe("язык эфира", () => {
  test("берётся по большинству кусков, а не по первому", () => {
    // Живой случай: эфир открывается музыкой, на ней распознавание уверенно
    // говорит «английский», хотя весь эфир русский.
    expect(prevailingLanguage(["en", "ru", "ru", "ru", "en", "ru"])).toBe("ru");
  });

  test("пустые определения не в счёт", () => {
    expect(prevailingLanguage(["", "", "ru"])).toBe("ru");
    expect(prevailingLanguage(["", ""])).toBe("");
  });

  test("регистр и пробелы не создают разных языков", () => {
    expect(prevailingLanguage(["RU", " ru ", "en"])).toBe("ru");
  });
});
