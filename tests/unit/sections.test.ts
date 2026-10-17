import { test, expect, describe } from "vitest";
import {
  normalizeSections,
  chunkSection,
  buildContextLine,
  MAX_CHUNK_CHARS,
  MAX_SECTION_CHARS,
  MIN_CHUNK_CHARS,
  type ParsedSection,
} from "../../src/shared/sections.ts";

function sectionOf(text: string, overrides: Partial<ParsedSection> = {}): ParsedSection {
  return {
    title: "Тема",
    text,
    startSeconds: 0,
    endSeconds: 600,
    category: "Just Chatting",
    ...overrides,
  };
}

describe("приведение разделов к рабочему размеру", () => {
  test("слишком короткий раздел склеивается со следующим, время расширяется", () => {
    const result = normalizeSections([
      sectionOf("Совсем коротко.", { startSeconds: 0, endSeconds: 60 }),
      sectionOf("Б".repeat(800), { startSeconds: 60, endSeconds: 600 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.endSeconds).toBe(600);
    expect(result[0]?.text).toContain("Совсем коротко.");
  });

  test("длинный раздел режется, содержание не теряется", () => {
    const paragraph = "А".repeat(1000);
    const long = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    const result = normalizeSections([sectionOf(long, { startSeconds: 0, endSeconds: 1000 })]);

    expect(result.length).toBeGreaterThan(1);
    for (const part of result) expect(part.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);

    const restored = result.map((part) => part.text).join("\n\n").replace(/\n/g, "");
    expect(restored.length).toBe(long.replace(/\n/g, "").length);
  });

  test("время частей идёт подряд и не выходит за границы раздела", () => {
    const long = Array.from({ length: 10 }, () => "А".repeat(1000)).join("\n\n");
    const result = normalizeSections([sectionOf(long, { startSeconds: 100, endSeconds: 1100 })]);

    expect(result[0]?.startSeconds).toBe(100);
    expect(result[result.length - 1]?.endSeconds).toBe(1100);
    for (let index = 1; index < result.length; index++) {
      expect(result[index]?.startSeconds).toBe(result[index - 1]?.endSeconds as number);
    }
  });
});

describe("нарезка раздела на куски", () => {
  const context = buildContextLine({
    publishedAt: "2026-03-14T18:03:00Z",
    category: "World of Warcraft",
    sectionTitle: "Причины перехода",
  });

  test("контекстная строка несёт дату, категорию и тему", () => {
    expect(context).toBe("Стрим 2026-03-14, World of Warcraft. Тема: Причины перехода.");
  });

  test("короткий раздел уходит в индекс одним куском", () => {
    const chunks = chunkSection(sectionOf("Короткий раздел."), context);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.startsWith(context)).toBe(true);
  });

  test("длинный раздел режется, куски не выходят за верхнюю границу", () => {
    const sentence = "Это предложение про содержание стрима. ";
    const chunks = chunkSection(sectionOf(sentence.repeat(300)), context);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const body = chunk.text.slice(context.length + 2);
      expect(body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  test("раздел-эпизод в пару тысяч знаков не уходит в индекс одним куском (008)", () => {
    // Кусок — единица поиска: вектор куска усредняет всё, что в нём сказано. Раздел в 2 500 знаков,
    // уложенный в один кусок, терял вопросы об одной из своих тем среди разделов других эфиров.
    const sentence = "Разговор шёл о сборке сервера и о том, что ломается. ";
    const text = sentence.repeat(Math.ceil(2500 / sentence.length));
    const chunks = chunkSection(sectionOf(text), context);

    expect(text.length).toBeGreaterThan(2400);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.text.slice(context.length + 2).length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  test("раздел не длиннее верхней границы куска остаётся одним куском", () => {
    const text = "Короткая история про сервер. ".repeat(Math.floor(MAX_CHUNK_CHARS / 29));
    expect(text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);

    expect(chunkSection(sectionOf(text), context)).toHaveLength(1);
  });

  test("куски всех частей покрывают текст раздела без потерь", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Предложение номер ${index} про содержание эфира.`).join(" ");
    const chunks = chunkSection(sectionOf(text), context);
    const joined = chunks.map((chunk) => chunk.text.slice(context.length + 2)).join(" ");

    for (let index = 0; index < 40; index += 1) expect(joined).toContain(`номер ${index} `);
    expect(MIN_CHUNK_CHARS).toBeLessThan(MAX_CHUNK_CHARS);
  });

  test("соседние куски перекрываются — фраза на стыке не теряется", () => {
    const sentence = "Это предложение про содержание стрима. ";
    const chunks = chunkSection(sectionOf(sentence.repeat(300)), context);
    const first = chunks[0]?.text ?? "";
    const second = chunks[1]?.text ?? "";
    const tail = first.slice(-100);
    expect(second.includes(tail.slice(0, 40))).toBe(true);
  });

  test("номера кусков идут подряд с нуля", () => {
    const chunks = chunkSection(sectionOf("Текст. ".repeat(500)), context);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });
});

