import { test, expect, describe } from "bun:test";
import {
  parseSearchRequest,
  searchKnowledge,
  NO_KNOWLEDGE_MESSAGE,
} from "../../src/worker/routes/knowledge.ts";
import { buildFilter } from "../../src/shared/knowledge.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Services } from "../../src/worker/env.ts";
import type { FoundSection, SearchOptions } from "../../src/shared/knowledge.ts";

/**
 * Контракт проверяется без сети: форма запроса и форма ответа не должны
 * зависеть ни от модели, ни от хранилища.
 */
function servicesWith(documents: FoundSection[]): { services: Services; seen: SearchOptions[] } {
  const seen: SearchOptions[] = [];
  const services = {
    models: { embed: async () => [[0.1, 0.2]] },
    knowledge: {
      search: async (_vector: number[], options: SearchOptions) => {
        seen.push(options);
        return documents;
      },
    },
  } as unknown as Services;
  return { services, seen };
}

const section: FoundSection = {
  id: "2345678901:12",
  topic: "Причины перехода на новый движок",
  text: "Полный текст раздела.",
  score: 0.82,
  category: "World of Warcraft",
  stream: {
    vodId: "2345678901",
    title: "Пятничный разбор кода",
    publishedAt: "2026-03-14T18:03:00Z",
    url: "https://www.twitch.tv/videos/2345678901?t=1h12m30s",
  },
  startSeconds: 4350,
  endSeconds: 4720,
};

describe("разбор запроса знаний", () => {
  test("умолчания совпадают с контрактом", () => {
    const request = parseSearchRequest({ query: "про движок" });
    expect(request.topK).toBe(5);
    expect(request.minScore).toBe(0.65);
  });

  test("пустой вопрос отвергается", () => {
    expect(() => parseSearchRequest({ query: "   " })).toThrow(AppError);
  });

  test("вопрос в десять тысяч знаков не уходит в модель", () => {
    try {
      parseSearchRequest({ query: "а".repeat(10000) });
      throw new Error("запрос принят, хотя должен быть отвергнут");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
  });

  test("число результатов ограничено сверху", () => {
    expect(() => parseSearchRequest({ query: "тест", topK: 100 })).toThrow(AppError);
  });

  test("конец диапазона включает весь день", () => {
    const request = parseSearchRequest({ query: "тест", from: "2026-01-01", to: "2026-01-01" });
    expect((request.toUnix as number) - (request.fromUnix as number)).toBe(86399);
  });

  test("перевёрнутый диапазон дат отвергается", () => {
    expect(() => parseSearchRequest({ query: "тест", from: "2026-09-01", to: "2026-01-01" })).toThrow(
      AppError,
    );
  });

  test("дата не в формате ГГГГ-ММ-ДД отвергается", () => {
    expect(() => parseSearchRequest({ query: "тест", from: "01.09.2026" })).toThrow(AppError);
  });
});

describe("ответ на запрос знаний", () => {
  test("найденные разделы отдаются в форме контракта", async () => {
    const { services } = servicesWith([section]);
    const result = await searchKnowledge(parseSearchRequest({ query: "движок" }), services);

    expect(result.found).toBe(true);
    expect(result.documents[0]?.text).toBe("Полный текст раздела.");
    expect(result.documents[0]?.stream.url).toContain("?t=");
    expect(result.stats?.returned).toBe(1);
  });

  test("отсутствие знаний — обычный ответ, а не ошибка", async () => {
    const { services } = servicesWith([]);
    const result = await searchKnowledge(parseSearchRequest({ query: "рецепт борща" }), services);

    expect(result.found).toBe(false);
    expect(result.documents).toEqual([]);
    expect(result.message).toBe(NO_KNOWLEDGE_MESSAGE);
  });

  test("ограничения запроса доходят до хранилища", async () => {
    const { services, seen } = servicesWith([section]);
    await searchKnowledge(
      parseSearchRequest({ query: "тест", topK: 3, category: "Just Chatting", from: "2026-01-01" }),
      services,
    );

    expect(seen[0]?.topK).toBe(3);
    expect(seen[0]?.category).toBe("Just Chatting");
    expect(seen[0]?.fromUnix).toBeDefined();
  });
});

describe("фильтр хранилища", () => {
  test("собирается из границ и категории", () => {
    const filter = buildFilter({ topK: 5, minScore: 0.35, fromUnix: 100, toUnix: 200, category: "Just Chatting" });
    expect(filter).toBe("publishedAtUnix >= 100 AND publishedAtUnix <= 200 AND category = 'Just Chatting'");
  });

  test("без ограничений фильтр пуст", () => {
    expect(buildFilter({ topK: 5, minScore: 0.35 })).toBe("");
  });

  test("кавычки, обратный слэш и перевод строки в категории отвергаются", () => {
    // Способа заэкранировать кавычку внутри строки документация Upstash
    // Vector не описывает, поэтому такие значения не подставляются как есть:
    // иначе фильтр ломался бы на стороне сервиса вместо понятного отказа.
    const unsafe = ["Tom's game", 'Игра "Мир"', "C:\\Games", "первая\nвторая"];
    for (const category of unsafe) {
      expect(() => buildFilter({ topK: 5, minScore: 0.35, category })).toThrow(AppError);
    }
  });
});
