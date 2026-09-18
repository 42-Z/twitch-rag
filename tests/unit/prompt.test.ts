import { test, expect, describe } from "bun:test";
import {
  PROMPT_EXAMPLES,
  PROMPT_LANGUAGE,
  PROMPT_RESPONSE_FORMAT,
  PROMPT_ROLE,
  PROMPT_RULES,
  buildDocumentNameMessage,
  buildDocumentSystemPrompt,
  buildPartMessage,
  buildStreamerInfoPart,
  buildTranscriptMessage,
} from "../../src/shared/prompt.ts";

/**
 * Сборка инструкции. Порядок частей — не оформление: он совпадает у всех
 * разобранных чужих промптов (роль → правила → форма ответа и примеры), и
 * ломается он молча, поэтому проверяется.
 */
describe("порядок частей инструкции", () => {
  test("части идут в объявленном порядке", () => {
    const prompt = buildDocumentSystemPrompt();

    expect(prompt.indexOf(PROMPT_ROLE)).toBe(0);
    expect(prompt.indexOf(PROMPT_RULES)).toBeGreaterThan(prompt.indexOf(PROMPT_ROLE));
    expect(prompt.indexOf(PROMPT_RESPONSE_FORMAT)).toBeGreaterThan(prompt.indexOf(PROMPT_RULES));
    expect(prompt.indexOf(PROMPT_EXAMPLES)).toBeGreaterThan(prompt.indexOf(PROMPT_RESPONSE_FORMAT));
    // Требование языка стоит последним: оно — то, что модель читает перед
    // ответом, и ошибка языка объявлена в нём грубым провалом.
    expect(prompt.indexOf(PROMPT_LANGUAGE)).toBeGreaterThan(prompt.indexOf(PROMPT_EXAMPLES));
  });

  test("инструкция велит не выносить в ответ ход работы", () => {
    // Иначе модель отвечает рассуждением вместо документа: расшифровка
    // читается как продолжение задания, и без явного запрета шаги работы
    // утекают в ответ.
    expect(buildDocumentSystemPrompt()).toContain("В ОТВЕТ НЕ ВЫНОСИТСЯ");
  });

  test("без сведений о стримере в инструкции нет ни заголовка, ни следа", () => {
    const withoutField = buildDocumentSystemPrompt();
    const withEmptyField = buildDocumentSystemPrompt({ streamerInfo: "" });
    const withSpaces = buildDocumentSystemPrompt({ streamerInfo: "   \n  " });

    expect(withEmptyField).toBe(withoutField);
    expect(withSpaces).toBe(withoutField);
    expect(withoutField).not.toContain("Сведения о стримере");
  });

  test("заполненные сведения встают между ролью и правилами", () => {
    const prompt = buildDocumentSystemPrompt({ streamerInfo: "5opka — Михаил, собеседники: Соня, Влад." });

    expect(prompt).toContain("Соня, Влад");
    expect(prompt.indexOf("Сведения о стримере")).toBeGreaterThan(prompt.indexOf(PROMPT_ROLE));
    expect(prompt.indexOf("Сведения о стримере")).toBeLessThan(prompt.indexOf(PROMPT_RULES));
  });

  test("сведения служат опознанию, а не источником содержания", () => {
    // FR-018 и FR-019: иначе модель пересказывает описание канала вместо
    // того, что звучало в записи. Но и обратная крайность — «содержание
    // берётся только из расшифровки» без оговорки — мешала: модель
    // отказывалась брать оттуда верное написание имён, и «Booster» из
    // расшифровки так и оставался «Бустером». Здесь проверяются обе половины.
    const part = buildStreamerInfoPart("Соня, Влад");

    expect(part).toContain("чтобы верно писать имена");
    expect(part).toContain("Содержанием эфира эти сведения не являются");
    expect(part).toContain("расшифровка");
  });
});

describe("запрос прохода", () => {
  test("неизменная расшифровка идёт перед меняющимся участком", () => {
    // От порядка зависит кэш входа: всё, что стоит после меняющейся строки,
    // читается заново по полной цене.
    const transcript = buildTranscriptMessage({
      publishedAt: "2026-09-16T16:54:29Z",
      categories: [{ title: "Just Chatting", startSeconds: 0, endSeconds: 3600 }],
      fullTranscript: "[0] привет",
    });
    const part = buildPartMessage({ startSeconds: 0, endSeconds: 600 });

    expect(transcript).toContain("2026-09-16");
    expect(transcript).toContain("[0] привет");
    expect(transcript).not.toContain("Твой участок");
    expect(part).toContain("С 0 по 600 секунду");
    expect(part).not.toContain("[0] привет");
  });

  test("пустой список категорий не оставляет пустого места", () => {
    const transcript = buildTranscriptMessage({
      publishedAt: "2026-09-16T16:54:29Z",
      categories: [],
      fullTranscript: "[0] привет",
    });

    expect(transcript).toContain("категории не указаны");
  });
});

describe("запрос об имени документа", () => {
  test("на вход идут темы разделов с датой эфира", () => {
    const message = buildDocumentNameMessage({
      publishedAt: "2026-09-16T16:54:29Z",
      sectionTitles: ["Выборы и «Новые люди»", "История с удостоверением"],
    });

    expect(message).toContain("2026-09-16");
    expect(message).toContain("1. Выборы и «Новые люди»");
    expect(message).toContain("2. История с удостоверением");
  });
});
