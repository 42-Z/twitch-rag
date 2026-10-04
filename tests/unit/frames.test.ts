import { test, expect, describe } from "vitest";
import {
  FRAME_INTERVAL_SECONDS,
  MAX_FRAMES_PER_PASS,
  MAX_FRAMES_PER_REQUEST,
  composeReason,
  formatFramelessNote,
  frameWindows,
  framelessSeconds,
  framesInRange,
  limitFrames,
  minPassesForFrames,
  type Frame,
} from "../../src/shared/frames.ts";

const frame = (atSeconds: number): Frame => ({ atSeconds, url: `https://example.test/${atSeconds}` });

describe("окна кадров", () => {
  test("эфир 20 789 с — 115 окон по 180,77 с, как в замере", () => {
    // Те же 115 кадров, на которых считались токены и цена (baseline.md §3).
    const windows = frameWindows({ startSeconds: 0, endSeconds: 20789 });

    expect(windows).toHaveLength(115);
    for (const window of windows) {
      expect(window.endSeconds - window.startSeconds).toBeCloseTo(20789 / 115, 9);
    }
  });

  test("часть в шесть часов — 120 окон по 180 с", () => {
    const windows = frameWindows({ startSeconds: 0, endSeconds: 21600 });

    expect(windows).toHaveLength(120);
    expect(windows.every((window) => window.endSeconds - window.startSeconds === FRAME_INTERVAL_SECONDS)).toBe(true);
    expect(windows[0]?.momentSeconds).toBe(90);
  });

  test("12 600 с — 70 окон", () => {
    expect(frameWindows({ startSeconds: 0, endSeconds: 12600 })).toHaveLength(70);
  });

  test("вторая часть считается от своего начала, а не от нуля", () => {
    const windows = frameWindows({ startSeconds: 21600, endSeconds: 43200 });

    expect(windows).toHaveLength(120);
    expect(windows[0]?.startSeconds).toBe(21600);
    expect(windows[0]?.momentSeconds).toBe(21690);
    expect(windows.at(-1)?.endSeconds).toBe(43200);
  });

  test.each([
    [0, 90],
    [0, 269],
    [0, 270],
    [0, 449],
    [0, 450],
    [0, 3600],
    [0, 20789],
    [0, 21600],
    [21600, 43201],
    [1234, 9999],
  ])("отрезок %i–%i: окна стыкуются без дыр и наложений и покрывают его целиком", (from, to) => {
    const windows = frameWindows({ startSeconds: from, endSeconds: to });
    const length = to - from;

    expect(windows[0]?.startSeconds).toBe(from);
    expect(windows.at(-1)?.endSeconds).toBe(to);
    windows.forEach((window, position) => {
      expect(window.index).toBe(position);
      if (position > 0) expect(window.startSeconds).toBe(windows[position - 1]?.endSeconds);
      // Окно не короче полуинтервала: иначе в нём не нашлось бы честного сегмента.
      expect(window.endSeconds - window.startSeconds).toBeGreaterThanOrEqual(FRAME_INTERVAL_SECONDS / 2);
      // Расчётный момент — середина, округлённая вниз: от начала окна не меньше
      // 45 с без секунды на округление, и внутри окна.
      expect(window.momentSeconds).toBeGreaterThanOrEqual(window.startSeconds + FRAME_INTERVAL_SECONDS / 4 - 1);
      expect(window.momentSeconds).toBeLessThan(window.endSeconds);
    });
    const total = windows.reduce((sum, window) => sum + (window.endSeconds - window.startSeconds), 0);
    expect(total).toBeCloseTo(length, 6);
  });

  test("отрезок короче полутора интервалов — одно окно, даже совсем короткий", () => {
    expect(frameWindows({ startSeconds: 0, endSeconds: 60 })).toEqual([
      { index: 0, startSeconds: 0, endSeconds: 60, momentSeconds: 30 },
    ]);
    expect(frameWindows({ startSeconds: 100, endSeconds: 101 })).toHaveLength(1);
    expect(frameWindows({ startSeconds: 0, endSeconds: 269 })).toHaveLength(1);
    // Ровно полтора интервала — уже два окна (округление половины вверх).
    expect(frameWindows({ startSeconds: 0, endSeconds: 270 })).toHaveLength(2);
  });

  test("пустой, обратный и нечисловой отрезок окон не даёт", () => {
    expect(frameWindows({ startSeconds: 500, endSeconds: 500 })).toEqual([]);
    expect(frameWindows({ startSeconds: 500, endSeconds: 100 })).toEqual([]);
    expect(frameWindows({ startSeconds: 0, endSeconds: Number.NaN })).toEqual([]);
    expect(frameWindows({ startSeconds: 0, endSeconds: Number.POSITIVE_INFINITY })).toEqual([]);
  });
});

describe("кадры участка", () => {
  const frames = [frame(0), frame(180), frame(360), frame(540), frame(720)];

  test("граница включает начало участка и исключает конец", () => {
    expect(framesInRange(frames, { startSeconds: 180, endSeconds: 540 }).map((item) => item.atSeconds)).toEqual([
      180, 360,
    ]);
  });

  test("порядок — по возрастанию, как бы кадры ни пришли", () => {
    const shuffled = [frame(540), frame(0), frame(360), frame(180)];

    expect(framesInRange(shuffled, { startSeconds: 0, endSeconds: 1000 }).map((item) => item.atSeconds)).toEqual([
      0, 180, 360, 540,
    ]);
  });

  test("нет кадров или участок мимо них — пусто, вход не меняется", () => {
    expect(framesInRange([], { startSeconds: 0, endSeconds: 100 })).toEqual([]);
    expect(framesInRange(frames, { startSeconds: 1000, endSeconds: 2000 })).toEqual([]);
    expect(frames.map((item) => item.atSeconds)).toEqual([0, 180, 360, 540, 720]);
  });
});

describe("предел картинок на запрос", () => {
  const range = (count: number): Frame[] => Array.from({ length: count }, (_, index) => frame(index * 180));

  test("в пределе кадры не меняются", () => {
    const frames = range(MAX_FRAMES_PER_PASS);

    expect(limitFrames(frames)).toEqual(frames);
    expect(limitFrames(range(MAX_FRAMES_PER_REQUEST))).toHaveLength(MAX_FRAMES_PER_REQUEST);
  });

  test("120 кадров — ровно 50, первый и последний на месте, шаг ровный", () => {
    const frames = range(120);
    const limited = limitFrames(frames);

    expect(limited).toHaveLength(50);
    expect(limited[0]).toBe(frames[0]);
    expect(limited.at(-1)).toBe(frames.at(-1));

    const positions = limited.map((item) => item.atSeconds / 180);
    const steps = positions.slice(1).map((position, index) => position - (positions[index] as number));
    // 119 ÷ 49 = 2,43: шаг два или три кадра, и ни одной дыры больше.
    expect(Math.min(...steps)).toBe(2);
    expect(Math.max(...steps)).toBe(3);
  });

  test("51 кадр — 50, без повторов и в прежнем порядке", () => {
    const limited = limitFrames(range(51));

    expect(limited).toHaveLength(50);
    expect(new Set(limited.map((item) => item.atSeconds)).size).toBe(50);
    expect(limited.map((item) => item.atSeconds)).toEqual([...limited.map((item) => item.atSeconds)].sort((a, b) => a - b));
  });

  test("не обрезка с хвоста: конец участка без кадров не остаётся", () => {
    const limited = limitFrames(range(120));

    expect(limited.at(-1)?.atSeconds).toBe(119 * 180);
  });

  test("свой предел: один кадр — первый, ноль — пусто", () => {
    const frames = range(10);

    expect(limitFrames(frames, 1)).toEqual([frames[0]]);
    expect(limitFrames(frames, 0)).toEqual([]);
    expect(limitFrames(frames, 2)).toEqual([frames[0], frames[9]]);
  });
});

describe("число проходов по кадрам", () => {
  test.each([
    [0, 0],
    [-5, 0],
    [1, 1],
    [24, 1],
    [25, 2],
    [115, 5],
    [120, 5],
  ])("%i кадров — не меньше %i проходов", (count, passes) => {
    expect(minPassesForFrames(count)).toBe(passes);
  });

  test("на проход приходится не больше 24 кадров, а в худшем участке вдвое больше — не больше 50", () => {
    // Граница участка сдвигается к смене категории не дальше чем на полпрохода в обе стороны
    // (`planDocumentParts`), так что участок бывает почти вдвое длиннее среднего.
    expect(MAX_FRAMES_PER_PASS * 2).toBeLessThanOrEqual(MAX_FRAMES_PER_REQUEST);
    expect(Math.ceil(120 / minPassesForFrames(120))).toBeLessThanOrEqual(MAX_FRAMES_PER_PASS);
  });
});

describe("сколько эфира без кадров", () => {
  const stream = { startSeconds: 0, endSeconds: 20789 };
  /** По кадру в каждом окне — на целой секунде не раньше начала окна. */
  const onePerWindow = (range = stream): Frame[] =>
    frameWindows(range).map((window) => frame(Math.ceil(window.startSeconds)));

  test("все окна покрыты — ноль, пометки нет", () => {
    expect(framelessSeconds(stream, onePerWindow())).toBe(0);
  });

  test("кадров нет вовсе — вся длина отрезка", () => {
    // Прежний конвейер, запись без видео, сбой добычи: для документа это одно и то же.
    expect(framelessSeconds(stream, [])).toBe(20789);
    expect(framelessSeconds(stream, [], [])).toBe(20789);
  });

  test("не добыты три кадра из 115 — сумма длин их окон", () => {
    const frames = onePerWindow().filter((_, index) => ![10, 50, 100].includes(index));

    expect(frames).toHaveLength(112);
    // 3 × 20 789 ÷ 115 = 542,32
    expect(framelessSeconds(stream, frames)).toBe(542);
  });

  test("проход откатился — окна его участка непокрыты, хотя кадры в них были", () => {
    // Окна 20…39 лежат внутри 3 600–7 200; их кадры документ не видел.
    // 20 × 20 789 ÷ 115 = 3 615,48
    expect(framelessSeconds(stream, onePerWindow(), [{ startSeconds: 3600, endSeconds: 7200 }])).toBe(3615);
  });

  test("откат и недобытые кадры складываются без двойного счёта", () => {
    const frames = onePerWindow();
    // Окно 26 лежит внутри откатившегося участка, и кадра в нём к тому же нет:
    // оно непокрыто и считается один раз, а не дважды.
    const withoutOne = frames.filter((_, index) => index !== 26);

    expect(framelessSeconds(stream, withoutOne, [{ startSeconds: 3600, endSeconds: 7200 }])).toBe(3615);
  });

  test("участок отката без кадров ничего не добавляет", () => {
    // Откатился участок, в котором кадров и не было: окна там уже непокрыты.
    const frames = onePerWindow().filter((_, index) => index < 20 || index > 39);

    expect(framelessSeconds(stream, frames, [{ startSeconds: 3600, endSeconds: 7200 }])).toBe(3615);
  });

  test("кадр на границе окон относится к одному окну", () => {
    const range = { startSeconds: 0, endSeconds: 360 };

    // 180 — начало второго окна: первое остаётся без кадра.
    expect(framelessSeconds(range, [frame(180)])).toBe(180);
    // 179 — последняя секунда первого окна: без кадра остаётся второе.
    expect(framelessSeconds(range, [frame(179)])).toBe(180);
  });

  test("кадр вне отрезка окна не покрывает", () => {
    expect(framelessSeconds({ startSeconds: 0, endSeconds: 360 }, [frame(5000)])).toBe(360);
  });

  test("конец участка отката не включается: кадр на нём остаётся видимым", () => {
    const range = { startSeconds: 0, endSeconds: 21600 };
    const frames = onePerWindow(range);

    // Кадры на 3 600 … 7 020 потеряны (20 окон по 180 с), кадр на 7 200 — уже за участком.
    expect(framelessSeconds(range, frames, [{ startSeconds: 3600, endSeconds: 7200 }])).toBe(3600);
  });

  test("часть эфира считается от своего начала", () => {
    const part = { startSeconds: 21600, endSeconds: 43200 };

    expect(framelessSeconds(part, [])).toBe(21600);
    expect(framelessSeconds(part, onePerWindow(part))).toBe(0);
  });
});

describe("пометка о кадрах в записи", () => {
  test.each([
    [2400, "Без кадров: 40 мин эфира."],
    [20789, "Без кадров: 5 ч 46 мин эфира."],
    [20, "Без кадров: меньше минуты эфира."],
    [0, ""],
  ])("%i с — «%s»", (seconds, note) => {
    expect(formatFramelessNote(seconds)).toBe(note);
  });

  test("причина собирается из двух пометок через пробел", () => {
    expect(composeReason("Разделы не покрывают 12 мин эфира.", "Без кадров: 40 мин эфира.")).toBe(
      "Разделы не покрывают 12 мин эфира. Без кадров: 40 мин эфира.",
    );
  });

  test("одна пометка — без лишних пробелов", () => {
    expect(composeReason("", "Без кадров: 40 мин эфира.")).toBe("Без кадров: 40 мин эфира.");
    expect(composeReason("Разделы не покрывают 12 мин эфира.", "")).toBe("Разделы не покрывают 12 мин эфира.");
  });

  test("нечего сказать — пустая строка, чтобы не висела причина прошлой попытки", () => {
    expect(composeReason("", "")).toBe("");
  });
});
