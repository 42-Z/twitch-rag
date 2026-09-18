import { test, expect, describe } from "bun:test";
import { composePart, type PartComposition } from "../../src/shared/document-parts.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { ComposedSection, DocumentPartRequest } from "../../src/shared/openrouter.ts";

/**
 * Проводка одного прохода: что уходит в запрос к модели и что делается при
 * обрыве по потолку.
 *
 * Проверяется здесь, а не живым разбором, потому что всё это — чистая логика
 * сборки запроса. Прежде она лежала в модуле разбора, который вне Cloudflare
 * не импортируется, и не была покрыта ничем: пропади по дороге поле от
 * владельца канала — заметить это можно было бы только на живом сервисе.
 */
const section = (title: string, startSeconds: number, endSeconds: number): ComposedSection => ({
  title,
  text: "Текст раздела.",
  startSeconds,
  endSeconds,
});

/** Заглушка адаптера: запоминает запросы и отвечает по заданному сценарию. */
function composerWith(
  answer: (request: DocumentPartRequest, call: number) => ComposedSection[],
): { composer: { composeDocumentPart(request: DocumentPartRequest): Promise<ComposedSection[]> }; seen: DocumentPartRequest[] } {
  const seen: DocumentPartRequest[] = [];
  return {
    seen,
    composer: {
      composeDocumentPart: async (request) => {
        seen.push(request);
        return answer(request, seen.length);
      },
    },
  };
}

const input: PartComposition = {
  transcript: "[0] привет\n[30] сегодня разбираем движок",
  part: { startSeconds: 0, endSeconds: 3600 },
  publishedAt: "2026-09-16T16:54:29Z",
  categories: [{ title: "Just Chatting", startSeconds: 0, endSeconds: 3600 }],
  streamerInfo: "5opka — Михаил. Постоянные собеседники: Соня, Влад.",
  sessionId: "2875806701",
};

describe("что уходит в запрос прохода", () => {
  test("сведения о стримере доходят до модели", () => {
    // То самое место, которое иначе проверялось бы только живым разбором:
    // владелец заполнил поле — оно обязано оказаться в запросе.
    const { composer, seen } = composerWith(() => [section("Тема", 0, 3600)]);

    return composePart(composer, input).then(() => {
      expect(seen[0]?.streamerInfo).toBe("5opka — Михаил. Постоянные собеседники: Соня, Влад.");
    });
  });

  test("пустые сведения не подменяются ничем", async () => {
    const { composer, seen } = composerWith(() => [section("Тема", 0, 3600)]);

    await composePart(composer, { ...input, streamerInfo: "" });

    expect(seen[0]?.streamerInfo).toBe("");
  });

  test("остальные поля запроса идут как есть", async () => {
    const { composer, seen } = composerWith(() => [section("Тема", 0, 3600)]);

    await composePart(composer, input);

    expect(seen[0]?.fullTranscript).toBe(input.transcript);
    expect(seen[0]?.part).toEqual({ startSeconds: 0, endSeconds: 3600 });
    expect(seen[0]?.publishedAt).toBe("2026-09-16T16:54:29Z");
    // Ключ закрепления общий у проходов одной записи: иначе кэш входа не сработает.
    expect(seen[0]?.sessionId).toBe("2875806701");
  });
});

describe("обрыв по потолку", () => {
  test("участок делится пополам и обе половины пишутся отдельно", async () => {
    // Оборванный ответ неполон, и повторять тот же запрос бессмысленно:
    // причиной был размер, а не случайность.
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    const sections = await composePart(composer, input);

    expect(seen.map((request) => request.part)).toEqual([
      { startSeconds: 0, endSeconds: 3600 },
      { startSeconds: 0, endSeconds: 1800 },
      { startSeconds: 1800, endSeconds: 3600 },
    ]);
    expect(sections).toHaveLength(2);
  });

  test("сведения о стримере не теряются при делении", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    await composePart(composer, input);

    expect(seen.every((request) => request.streamerInfo === input.streamerInfo)).toBe(true);
  });

  test("короткий участок не дробится — обрыв уходит наверх", async () => {
    // Дробить дальше нечего, а вызовы модели множатся.
    const { composer, seen } = composerWith(() => {
      throw new AppError("output_truncated", "обрыв");
    });

    const short = { ...input, part: { startSeconds: 0, endSeconds: 400 } };
    await expect(composePart(composer, short)).rejects.toThrow(AppError);
    expect(seen).toHaveLength(1);
  });

  test("отказ модели повтором не лечится и наверх уходит как есть", async () => {
    const { composer, seen } = composerWith(() => {
      throw new AppError("model_refused", "отказ");
    });

    try {
      await composePart(composer, input);
      throw new Error("ожидалась ошибка");
    } catch (error) {
      expect((error as AppError).code).toBe("model_refused");
    }
    expect(seen).toHaveLength(1);
  });

  test("цепочка обрывов заканчивается на глубине, а не идёт вечно", async () => {
    const { composer, seen } = composerWith(() => {
      throw new AppError("output_truncated", "обрыв");
    });

    await expect(composePart(composer, input)).rejects.toThrow(AppError);

    // Участок делится, пока помещается: 3600 → 1800 → 900 → 450, дальше
    // половина короче предела деления, и обрыв признаётся отказом.
    expect(seen.map((request) => request.part.endSeconds - request.part.startSeconds)).toEqual([
      3600, 1800, 900, 450,
    ]);
  });

  test("неудача первой половины отменяет вторую", async () => {
    // Вторая половина уже никому не нужна: проход собирается целиком или не
    // собирается вовсе, а лишний вызов модели стоит денег.
    const { composer, seen } = composerWith(() => {
      throw new AppError("output_truncated", "обрыв");
    });

    await expect(composePart(composer, input)).rejects.toThrow(AppError);

    const halves = seen.map((request) => request.part.startSeconds);
    expect(halves).toEqual([0, 0, 0, 0]);
  });
});
