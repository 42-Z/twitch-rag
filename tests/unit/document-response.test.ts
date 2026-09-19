import { test, expect, describe } from "vitest";
import {
  parseComposedSections,
  readDocumentChoice,
  readDocumentNameChoice,
  type CompletionChoice,
} from "../../src/shared/openrouter.ts";
import { AppError } from "../../src/shared/errors.ts";

/**
 * Разбор ответа модели. Строгая схема обязывает модель, но не отменяет
 * проверку: обрыв по потолку ломает и её, а отказ приходит вовсе не тем
 * полем, которого ждёшь. Каждый исход обязан быть отличим от остальных —
 * иначе отказ выглядит невалидным ответом и уходит в повтор, который, по
 * документации, не помогает.
 */
const choice = (overrides: Partial<NonNullable<CompletionChoice["message"]>> & { finish_reason?: string }): CompletionChoice => ({
  finish_reason: overrides.finish_reason ?? "stop",
  message: { content: overrides.content ?? null, refusal: overrides.refusal ?? null },
});

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("ожидалась ошибка, её не было");
}

describe("исходы ответа модели", () => {
  test("пригодный ответ даёт разделы", () => {
    const sections = readDocumentChoice(
      choice({
        content: JSON.stringify({
          sections: [{ title: "Разбор движка", text: "Текст раздела.", startSeconds: 10, endSeconds: 90 }],
        }),
      }),
    );

    expect(sections).toEqual([
      { title: "Разбор движка", text: "Текст раздела.", startSeconds: 10, endSeconds: 90 },
    ]);
  });

  test("отказ модели отличается от негодного ответа", () => {
    expect(codeOf(() => readDocumentChoice(choice({ content: null, refusal: "не могу" })))).toBe("model_refused");
  });

  test("модерация считается отказом", () => {
    expect(
      codeOf(() => readDocumentChoice({ finish_reason: "content_filter", message: { content: null, refusal: null } })),
    ).toBe("model_refused");
  });

  test("обрыв по потолку отличается и от отказа, и от пустого ответа", () => {
    // По этому коду разбор переигрывает проход меньшим участком, а не
    // повторяет тот же запрос.
    expect(
      codeOf(() =>
        readDocumentChoice({
          finish_reason: "length",
          message: { content: '{"sections": [{"title": "обры', refusal: null },
        }),
      ),
    ).toBe("output_truncated");
  });

  test("ответ без вариантов — ошибка в теле при успешном статусе", () => {
    expect(codeOf(() => readDocumentChoice(undefined))).toBe("upstream_unavailable");
  });

  test("ответ без разделов отвергается", () => {
    expect(codeOf(() => readDocumentChoice(choice({ content: "{}" })))).toBe("upstream_unavailable");
  });

  test("пустой список разделов — законный ответ для участка без речи", () => {
    // Инструкция разрешает ответить так, когда на участке звучала только
    // музыка или тишина. Отличить это от отказа можно по признаку остановки:
    // обрыв по потолку и отказ модели приходят другими исходами, а пропуск
    // речи виден по разрыву во времени, который попадает в реестр.
    expect(readDocumentChoice(choice({ content: '{"sections": []}' }))).toEqual([]);
  });

  test("не JSON отвергается", () => {
    expect(codeOf(() => readDocumentChoice(choice({ content: "текст вместо JSON" })))).toBe("upstream_unavailable");
  });
});

describe("проверка разделов по схеме", () => {
  test("раздел с недостающим полем отвергается целиком", () => {
    // Молча выбросить раздел значило бы потерять содержание незаметно —
    // ровно то, против чего эта задача.
    const raw = JSON.stringify({ sections: [{ title: "Тема", startSeconds: 0, endSeconds: 60 }] });
    expect(codeOf(() => parseComposedSections(raw))).toBe("upstream_unavailable");
  });

  test("раздел с временем задом наперёд отсеивается, а годные остаются", () => {
    const raw = JSON.stringify({
      sections: [
        { title: "Кривой", text: "Текст.", startSeconds: 90, endSeconds: 30 },
        { title: "Годный", text: "Текст.", startSeconds: 0, endSeconds: 30 },
      ],
    });

    expect(parseComposedSections(raw).map((section) => section.title)).toEqual(["Годный"]);
  });

  test("отрицательное начало приводится к нулю", () => {
    const raw = JSON.stringify({
      sections: [{ title: "Тема", text: "Текст.", startSeconds: -5, endSeconds: 30 }],
    });
    expect(parseComposedSections(raw)[0]?.startSeconds).toBe(0);
  });

  test("раздел, у которого время уходит в минус целиком, отсеивается", () => {
    // Проверка «конец больше начала» должна смотреть на те значения, которые
    // пойдут дальше. Иначе раздел с началом −12 и концом −4 её проходит, а
    // после обрезки начала нулём получается раздел, у которого начало больше
    // конца: время в документе печатается как нулевое, а в метаданные куска
    // уходит отрицательный конец.
    const raw = JSON.stringify({
      sections: [
        { title: "Минус", text: "Текст.", startSeconds: -12, endSeconds: -4 },
        { title: "Годный", text: "Текст.", startSeconds: 10, endSeconds: 30 },
      ],
    });

    expect(parseComposedSections(raw).map((section) => section.title)).toEqual(["Годный"]);
  });
});

describe("имя документа", () => {
  test("имя приводится к одной строке", () => {
    expect(readDocumentNameChoice(choice({ content: '{"name": "  Как разыграли\\nзрителей  "}' }))).toBe(
      "Как разыграли зрителей",
    );
  });

  test("пустое имя — отказ, а не документ без имени", () => {
    expect(codeOf(() => readDocumentNameChoice(choice({ content: '{"name": "   "}' })))).toBe("upstream_unavailable");
  });

  test("ответ не по схеме отвергается", () => {
    expect(codeOf(() => readDocumentNameChoice(choice({ content: '{"title": "не то поле"}' })))).toBe(
      "upstream_unavailable",
    );
  });
});
