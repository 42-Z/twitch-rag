import { test, expect, describe } from "vitest";
import { AUDIO_CHUNK_SECONDS, MAX_PART_SECONDS, splitIntoParts } from "../../src/shared/stream-parts.ts";

const H = 3600;

describe("деление эфира на части", () => {
  test("ровно шесть часов не делится — граница включающая", () => {
    expect(splitIntoParts(6 * H)).toEqual([{ index: 1, count: 1, startSeconds: 0, endSeconds: 6 * H }]);
  });

  test("эфир короче порога и нулевой — одна часть", () => {
    expect(splitIntoParts(5 * H + 47 * 60)).toHaveLength(1);
    expect(splitIntoParts(0)).toEqual([{ index: 1, count: 1, startSeconds: 0, endSeconds: 0 }]);
  });

  test("шесть часов и секунда — две равные части, а не шесть часов и секунда", () => {
    const parts = splitIntoParts(6 * H + 1);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.endSeconds).toBe(3 * H);
    expect(parts[1]?.startSeconds).toBe(3 * H);
    expect(parts[1]?.endSeconds).toBe(6 * H + 1);
  });

  test("6 ч 1 мин — две части по три часа", () => {
    const parts = splitIntoParts(6 * H + 60);
    expect(parts.map((part) => part.endSeconds - part.startSeconds)).toEqual([3 * H + 30, 3 * H + 30]);
  });

  test("12 часов — две по шесть, 15 часов — три по пять, 9 часов — две", () => {
    expect(splitIntoParts(12 * H).map((part) => part.endSeconds - part.startSeconds)).toEqual([6 * H, 6 * H]);
    expect(splitIntoParts(15 * H).map((part) => part.endSeconds - part.startSeconds)).toEqual([5 * H, 5 * H, 5 * H]);
    expect(splitIntoParts(9 * H)).toHaveLength(2);
  });

  test.each([6 * H + 1, 7 * H + 13, 9 * H, 12 * H, 12 * H + 1, 17 * H + 12345, 30 * H])(
    "эфир %i с: части стыкуются, покрывают эфир и не длиннее порога",
    (duration) => {
      const parts = splitIntoParts(duration);
      expect(parts[0]?.startSeconds).toBe(0);
      expect(parts.at(-1)?.endSeconds).toBe(duration);
      parts.forEach((part, position) => {
        expect(part.index).toBe(position + 1);
        expect(part.count).toBe(parts.length);
        expect(part.endSeconds - part.startSeconds).toBeLessThanOrEqual(MAX_PART_SECONDS);
        if (position > 0) expect(part.startSeconds).toBe(parts[position - 1]?.endSeconds);
      });
      // Число частей — наименьшее возможное.
      expect(parts.length).toBe(Math.ceil(duration / MAX_PART_SECONDS));
      // Равны с точностью до секунды.
      const lengths = parts.map((part) => part.endSeconds - part.startSeconds);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    },
  );

  test("отрицательная и нечисловая длительность — ошибка", () => {
    expect(() => splitIntoParts(-1)).toThrow(RangeError);
    expect(() => splitIntoParts(Number.NaN)).toThrow(RangeError);
    expect(() => splitIntoParts(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

/**
 * Порог и длина куска выведены из лимита платформы — 50 внешних обращений на
 * прогон Workflow. Этот расчёт сторожит их связь: изменил один — тест напомнит
 * пересчитать бюджет.
 *
 * Числа ниже скопированы из `src/worker/workflow.ts` (CHARS_PER_PART,
 * EMBED_BATCH: под Node он не подключается) и из
 * `specs/006-split-long-streams/research.md` §2. При изменении — пересчитать.
 */
describe("бюджет внешних обращений на часть", () => {
  const CHARS_PER_PART = 30000;
  const EMBED_BATCH = 32;
  const CONSTANT = 8;
  const CHUNKS_PER_MINUTE = 0.2;
  const TYPICAL_CHARS_PER_MINUTE = 579;
  const DENSE_CHARS_PER_MINUTE = 900;
  const RETRIES = 2;
  const CLEANUP = 1;

  const budget = (charsPerMinute: number): number => {
    const minutes = MAX_PART_SECONDS / 60;
    const audio = MAX_PART_SECONDS / AUDIO_CHUNK_SECONDS;
    const passes = Math.ceil((minutes * charsPerMinute) / CHARS_PER_PART);
    const batches = Math.ceil((minutes * CHUNKS_PER_MINUTE) / EMBED_BATCH);
    return audio + passes + 2 * batches + CONSTANT;
  };

  test("длина куска делит порог без остатка", () => {
    expect(MAX_PART_SECONDS % AUDIO_CHUNK_SECONDS).toBe(0);
  });

  test("обычная речь — 39 обращений из 50", () => {
    expect(budget(TYPICAL_CHARS_PER_MINUTE)).toBe(39);
  });

  test("плотная речь, повторы и уборка — 46 из 50", () => {
    const worst = budget(DENSE_CHARS_PER_MINUTE) + RETRIES + CLEANUP;
    expect(worst).toBe(46);
    expect(worst).toBeLessThanOrEqual(50);
  });
});
