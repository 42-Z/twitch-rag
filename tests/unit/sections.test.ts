import { test, expect, describe } from "bun:test";
import {
  parseDocument,
  normalizeSections,
  chunkSection,
  buildContextLine,
  renderSection,
  MAX_SECTION_CHARS,
  type ParsedSection,
} from "../../src/shared/sections.ts";

const document = `# Пятничный разбор кода

## Причины перехода на новый движок [1:12:30 — 1:18:40 · World of Warcraft]

Стример объяснил, почему старый движок перестал устраивать.

Главная причина — время сборки.

## Ответы на вопросы чата [1:18:40 — 1:25:00]

Обсудили планы на следующую неделю.
`;

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

describe("разбор документа", () => {
  test("находит разделы, время и категорию", () => {
    const sections = parseDocument(document);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.title).toBe("Причины перехода на новый движок");
    expect(sections[0]?.startSeconds).toBe(4350);
    expect(sections[0]?.endSeconds).toBe(4720);
    expect(sections[0]?.category).toBe("World of Warcraft");
    expect(sections[0]?.text).toContain("время сборки");
  });

  test("заголовок без категории читается, категория остаётся пустой", () => {
    const sections = parseDocument(document);
    expect(sections[1]?.category).toBe("");
    expect(sections[1]?.startSeconds).toBe(4720);
  });

  test("другое тире от модели не ломает разбор", () => {
    const sections = parseDocument("## Тема [0:10 - 0:20 · Игра]\n\nТекст раздела.");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.endSeconds).toBe(20);
  });

  test("текст вне разделов игнорируется, пустой раздел не создаётся", () => {
    const sections = parseDocument("# Заголовок\n\nВступление.\n\n## Тема [0:00 — 0:10]\n");
    expect(sections).toHaveLength(0);
  });

  test("собранный обратно раздел читается тем же разбором", () => {
    const original = parseDocument(document)[0];
    expect(original).toBeDefined();
    const restored = parseDocument(renderSection(original as ParsedSection))[0];
    expect(restored).toEqual(original as ParsedSection);
  });
});

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
      expect(body.length).toBeLessThanOrEqual(3000);
    }
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
