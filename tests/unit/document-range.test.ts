import { test, expect, describe } from "vitest";
import { findCoverageGaps, planDocumentParts } from "../../src/shared/categories.ts";

/**
 * Проходы составления и разрывы покрытия считали время от нуля до
 * длительности. У второй части эфира время начинается не с нуля, и оба места
 * обязаны получить границы отрезка.
 */
const range = { startSeconds: 21600, endSeconds: 43200 };

describe("проходы составления на отрезке", () => {
  test("один проход — весь отрезок", () => {
    expect(planDocumentParts(range, [], 1)).toEqual([range]);
  });

  test("проходы лежат внутри отрезка и стыкуются", () => {
    const parts = planDocumentParts(range, [], 3);
    expect(parts).toHaveLength(3);
    expect(parts[0]?.startSeconds).toBe(21600);
    expect(parts.at(-1)?.endSeconds).toBe(43200);
    parts.forEach((part, position) => {
      expect(part.endSeconds).toBeGreaterThan(part.startSeconds);
      if (position > 0) expect(part.startSeconds).toBe(parts[position - 1]?.endSeconds);
    });
  });

  test("смена категории вне отрезка швом не служит", () => {
    const chapters = [
      { title: "Прежняя", startSeconds: 0, endSeconds: 21600 },
      { title: "Новая", startSeconds: 21600, endSeconds: 43200 },
    ];
    const parts = planDocumentParts(range, chapters, 2);
    expect(parts[0]?.startSeconds).toBe(21600);
    expect(parts[0]?.endSeconds).toBe(32400); // середина: 21600 + 10800
  });

  test("смена категории близко к идеальной границе — шов по ней", () => {
    const chapters = [{ title: "Игра", startSeconds: 33000, endSeconds: 43200 }];
    expect(planDocumentParts(range, chapters, 2)[0]?.endSeconds).toBe(33000);
  });

  test("отрезок с нуля ведёт себя как раньше", () => {
    expect(planDocumentParts({ startSeconds: 0, endSeconds: 7200 }, [], 2)).toEqual([
      { startSeconds: 0, endSeconds: 3600 },
      { startSeconds: 3600, endSeconds: 7200 },
    ]);
  });
});

describe("разрывы покрытия на отрезке", () => {
  const section = (startSeconds: number, endSeconds: number) => ({
    title: "т",
    text: "т",
    category: "",
    startSeconds,
    endSeconds,
  });

  test("сплошное покрытие отрезка разрывов не даёт", () => {
    expect(findCoverageGaps([section(21600, 30000), section(30000, 43200)], range)).toEqual([]);
  });

  test("непокрытое начало части — разрыв от её начала, а не от нуля", () => {
    expect(findCoverageGaps([section(23400, 43200)], range)).toEqual([{ from: 21600, to: 23400 }]);
  });

  test("непокрытый хвост части", () => {
    expect(findCoverageGaps([section(21600, 40000)], range)).toEqual([{ from: 40000, to: 43200 }]);
  });

  test("отрезок с нуля ведёт себя как раньше", () => {
    expect(findCoverageGaps([section(1000, 3600)], { startSeconds: 0, endSeconds: 3600 })).toEqual([
      { from: 0, to: 1000 },
    ]);
  });
});
