import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { APIError } from "openai";
import {
  composePart,
  composePasses,
  type ComposedPart,
  type PartComposition,
} from "../../src/shared/document-parts.ts";
import { AppError, upstreamError } from "../../src/shared/errors.ts";
import type { ComposedSection, DocumentPartRequest } from "../../src/shared/openrouter.ts";
import type { Frame } from "../../src/shared/frames.ts";

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

    const { sections } = await composePart(composer, input);

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

describe("кадры своего участка", () => {
  const frameAt = (atSeconds: number) => ({ atSeconds, url: `https://example.test/frame-${atSeconds}.jpg` });
  /** Кадр каждые три минуты по всему часу: 0, 180, … 3420. */
  const hourOfFrames = Array.from({ length: 20 }, (_, index) => frameAt(index * 180));
  const seconds = (request: DocumentPartRequest | undefined): number[] =>
    (request?.frames ?? []).map((frame) => frame.atSeconds);

  test("проход видит только кадры своего участка", async () => {
    const { composer, seen } = composerWith(() => [section("Тема", 1800, 2700)]);

    await composePart(composer, { ...input, part: { startSeconds: 1800, endSeconds: 2700 }, frames: hourOfFrames });

    expect(seconds(seen[0])).toEqual([1800, 1980, 2160, 2340, 2520]);
  });

  test("после обрыва по потолку каждая половина получает свои кадры, а не все", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    await composePart(composer, { ...input, frames: hourOfFrames });

    // Целый проход видел весь час; первая половина — до середины, вторая — от неё.
    expect(seconds(seen[0])).toHaveLength(20);
    expect(seconds(seen[1])).toEqual(hourOfFrames.slice(0, 10).map((frame) => frame.atSeconds));
    expect(seconds(seen[2])).toEqual(hourOfFrames.slice(10).map((frame) => frame.atSeconds));
  });

  test("кадр на самой границе середины уходит во вторую половину", async () => {
    // Середина участка 0–3600 — 1800; кадр на 1800-й секунде принадлежит [1800, 3600).
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    await composePart(composer, { ...input, frames: hourOfFrames });

    expect(seconds(seen[1])).not.toContain(1800);
    expect(seconds(seen[2])[0]).toBe(1800);
  });

  test("без кадров запрос не содержит поля frames — он прежний", async () => {
    const { composer, seen } = composerWith(() => [section("Тема", 0, 3600)]);

    await composePart(composer, input);
    await composePart(composer, { ...input, frames: [] });
    // Кадры есть, но все за пределами участка.
    await composePart(composer, { ...input, part: { startSeconds: 0, endSeconds: 600 }, frames: [frameAt(5000)] });

    expect(seen).toHaveLength(3);
    for (const request of seen) expect("frames" in request).toBe(false);
  });
});

/**
 * Отказ по кадрам так, как его строит адаптер: ошибка SDK лежит в `cause` у
 * `AppError`. Голый объект со статусом не показал бы, доходит ли статус до
 * классификации (`isFramesRejection` читает его именно у причины).
 */
function rejectedBy(status: number): AppError {
  const sdk = APIError.generate(
    status,
    {
      message: "Provider returned error",
      code: status,
      metadata: { raw: "origin returned HTTP 404", provider_name: "Meta", provider_error_code: "media_url_origin_error" },
    },
    `${status} Provider returned error`,
    new Headers(),
  );
  return upstreamError("составление документа", sdk);
}

/** Кадр каждые три минуты от нуля на `seconds` секунд эфира. */
function framesEvery180(seconds: number): Frame[] {
  return Array.from({ length: Math.floor(seconds / 180) }, (_, index) => ({
    atSeconds: index * 180,
    url: `https://example.test/frame-${index * 180}.jpg`,
  }));
}

const hasFrames = (request: DocumentPartRequest): boolean => request.frames !== undefined;

describe("откат без кадров", () => {
  const frames = framesEvery180(3600);

  beforeEach(() => {
    // Адаптер пишет причину в журнал, а откат — предупреждение; в выводе проверок им делать нечего.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("запрос с кадрами отвергнут — тот же участок пишется ещё раз без кадров", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw rejectedBy(400);
      return [section("Тема", request.part.startSeconds, request.part.endSeconds)];
    });

    const composed = await composePart(composer, { ...input, frames });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.frames).toHaveLength(20);
    expect("frames" in (seen[1] as DocumentPartRequest)).toBe(false);
    expect(seen[1]?.part).toEqual({ startSeconds: 0, endSeconds: 3600 });
    expect(composed.sections).toHaveLength(1);
    expect(composed.withoutFrames).toEqual([{ startSeconds: 0, endSeconds: 3600 }]);
  });

  test("повторный запрос несёт те же сведения и тот же ключ закрепления", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw rejectedBy(400);
      return [section("Тема", request.part.startSeconds, request.part.endSeconds)];
    });

    await composePart(composer, { ...input, frames });

    expect(seen[1]?.streamerInfo).toBe(input.streamerInfo);
    expect(seen[1]?.sessionId).toBe(input.sessionId);
    expect(seen[1]?.fullTranscript).toBe(input.transcript);
  });

  test("отказ модели по содержанию тоже откатывает проход", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("model_refused", "отказ");
      return [section("Тема", request.part.startSeconds, request.part.endSeconds)];
    });

    const composed = await composePart(composer, { ...input, frames });

    expect(seen).toHaveLength(2);
    expect(composed.withoutFrames).toEqual([{ startSeconds: 0, endSeconds: 3600 }]);
  });

  test("у участка не было кадров — откатывать нечего, ошибка уходит наверх", async () => {
    const { composer, seen } = composerWith(() => {
      throw rejectedBy(400);
    });

    await expect(composePart(composer, input)).rejects.toThrow(AppError);
    expect(seen).toHaveLength(1);
  });

  test("ошибка не по кадрам уходит наверх без второго запроса", async () => {
    // Частота запросов: кадры тут ни при чём, и повтор без них её не вылечит.
    const { composer, seen } = composerWith(() => {
      throw rejectedBy(429);
    });

    await expect(composePart(composer, { ...input, frames })).rejects.toThrow(AppError);
    expect(seen).toHaveLength(1);
  });

  test("повторная ошибка уже без кадров уходит наверх как есть", async () => {
    const { composer, seen } = composerWith(() => {
      throw rejectedBy(400);
    });

    await expect(composePart(composer, { ...input, frames })).rejects.toThrow(AppError);
    // Ровно два запроса: с кадрами и без них. Откат на откате не строится.
    expect(seen).toHaveLength(2);
    expect(hasFrames(seen[0] as DocumentPartRequest)).toBe(true);
    expect(hasFrames(seen[1] as DocumentPartRequest)).toBe(false);
  });

  test("обрыв по потолку и отказ по кадрам в одной половине — откатывается только она", async () => {
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      // Вторым идёт запрос первой половины с кадрами — его и отвергают.
      if (call === 2) throw rejectedBy(400);
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    const composed = await composePart(composer, { ...input, frames });

    expect(seen.map((request) => request.part)).toEqual([
      { startSeconds: 0, endSeconds: 3600 },
      { startSeconds: 0, endSeconds: 1800 },
      { startSeconds: 0, endSeconds: 1800 },
      { startSeconds: 1800, endSeconds: 3600 },
    ]);
    expect(seen.map(hasFrames)).toEqual([true, true, false, true]);
    expect(composed.withoutFrames).toEqual([{ startSeconds: 0, endSeconds: 1800 }]);
    expect(composed.sections).toHaveLength(2);
  });

  test("откаты общие на весь проход: когда они кончились, половина идёт без кадров сразу", async () => {
    // Откат стоит обращение, а их запас на прогон ограничен: после последнего
    // оставшиеся запросы кадров не просят вовсе.
    const { composer, seen } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      if (call === 2) throw rejectedBy(400);
      return [section(`Тема ${call}`, request.part.startSeconds, request.part.endSeconds)];
    });

    const composed = await composePart(composer, { ...input, frames }, { fallbacksLeft: 1 });

    expect(seen.map(hasFrames)).toEqual([true, true, false, false]);
    expect(composed.withoutFrames).toEqual([
      { startSeconds: 0, endSeconds: 1800 },
      { startSeconds: 1800, endSeconds: 3600 },
    ]);
  });
});

describe("проходы подряд и предохранитель откатов", () => {
  const parts = Array.from({ length: 11 }, (_, index) => ({ startSeconds: index * 1800, endSeconds: (index + 1) * 1800 }));
  const frames = framesEvery180(19_800);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Композитор, отвергающий кадры в проходах, что начинаются раньше `limit`. */
  const rejectingBefore = (limit: number) =>
    composerWith((request) => {
      if (hasFrames(request) && request.part.startSeconds < limit) throw rejectedBy(400);
      return [section("Тема", request.part.startSeconds, request.part.endSeconds)];
    });

  const run = async (
    composer: { composeDocumentPart(request: DocumentPartRequest): Promise<ComposedSection[]> },
    options: { step?: (name: string, run: () => Promise<ComposedPart>) => Promise<ComposedPart>; frames?: readonly Frame[] } = {},
  ) => {
    const passes: Array<{ frames: number; fallbacksLeft: number }> = [];
    const names: string[] = [];
    const result = await composePasses({
      parts,
      frames: options.frames ?? frames,
      stepName: (index, count) => `часть ${index + 1} из ${count}`,
      step:
        options.step ??
        (async (name, work) => {
          names.push(name);
          return await work();
        }),
      compose: async (pass) => {
        passes.push({ frames: pass.frames.length, fallbacksLeft: pass.fallbacksLeft });
        return await composePart(
          composer,
          { ...input, part: pass.part, frames: pass.frames },
          { fallbacksLeft: pass.fallbacksLeft },
        );
      },
    });
    return { result, passes, names };
  };

  test("без отказов — по запросу на проход, кадры у каждого", async () => {
    const { composer, seen } = composerWith((request) => [
      section("Тема", request.part.startSeconds, request.part.endSeconds),
    ]);

    const { result, names } = await run(composer);

    expect(seen).toHaveLength(11);
    expect(seen.every(hasFrames)).toBe(true);
    expect(result.sections).toHaveLength(11);
    expect(result.withoutFrames).toEqual([]);
    expect(names).toHaveLength(11);
    expect(names[0]).toBe("часть 1 из 11");
    expect(names[10]).toBe("часть 11 из 11");
  });

  test("три первых прохода отвергают кадры — запросов 14, а не 22", async () => {
    // Без предохранителя каждый из одиннадцати проходов тратил бы запрос на
    // отказ и ещё один на повтор: 11 + 11 = 22, а запас прогона — 4 обращения.
    const { composer, seen } = rejectingBefore(3 * 1800);

    const { result, passes } = await run(composer);

    expect(seen).toHaveLength(14);
    // С кадрами — только три отвергнутых запроса; остальные одиннадцать без них.
    expect(seen.filter(hasFrames)).toHaveLength(3);
    // Четвёртый проход и дальше идут без кадров с самого начала.
    expect(passes.map((pass) => pass.frames)).toEqual([...Array(3).fill(110), ...Array(8).fill(0)]);
    expect(passes.map((pass) => pass.fallbacksLeft)).toEqual([3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Весь эфир остался без кадров: три отката и восемь проходов, не получивших кадры.
    expect(result.withoutFrames).toEqual(parts);
    expect(result.sections).toHaveLength(11);
  });

  test("два отказа не исчерпывают откаты — остальные проходы с кадрами", async () => {
    const { composer, seen } = rejectingBefore(2 * 1800);

    const { result } = await run(composer);

    expect(seen).toHaveLength(13);
    expect(seen.filter(hasFrames)).toHaveLength(2 + 9);
    expect(result.withoutFrames).toEqual(parts.slice(0, 2));
  });

  test("несколько откатов внутри одного прохода считаются все", async () => {
    // Проход оборвался по потолку, и обе половины отвергли кадры: два отката.
    const { composer } = composerWith((request, call) => {
      if (call === 1) throw new AppError("output_truncated", "обрыв");
      // Кадры отвергаются только в первом проходе; остальные проходят с ними.
      if (hasFrames(request) && request.part.startSeconds < 3600) throw rejectedBy(400);
      return [section("Тема", request.part.startSeconds, request.part.endSeconds)];
    });
    const threeParts = Array.from({ length: 3 }, (_, index) => ({
      startSeconds: index * 3600,
      endSeconds: (index + 1) * 3600,
    }));
    const passes: number[] = [];

    await composePasses({
      parts: threeParts,
      frames: framesEvery180(10_800),
      stepName: (index, count) => `часть ${index + 1} из ${count}`,
      step: async (_name, work) => await work(),
      compose: async (pass) => {
        passes.push(pass.fallbacksLeft);
        return await composePart(
          composer,
          { ...input, part: pass.part, frames: pass.frames },
          { fallbacksLeft: pass.fallbacksLeft },
        );
      },
    });

    // Первому проходу полагалось три отката, он потратил два; следующим остался один.
    expect(passes).toEqual([3, 1, 1]);
  });

  test("счёт откатов восстанавливается из результатов шагов, а не из памяти цикла", async () => {
    // Workflow при переигровке идёт по циклу заново и берёт готовые результаты
    // шагов из кэша. Счёт откатов обязан получиться тем же.
    const cache = new Map<string, ComposedPart>();
    const first = rejectingBefore(3 * 1800);
    await run(first.composer, {
      step: async (name, work) => {
        const value = await work();
        cache.set(name, value);
        return value;
      },
    });
    expect(cache.size).toBe(11);

    // Переигровка: первые три шага отданы из кэша без вызова модели, остальные идут вживую.
    const replay = rejectingBefore(3 * 1800);
    const { passes } = await run(replay.composer, {
      step: async (name, work) => {
        const index = Number(name.split(" ")[1]) - 1;
        return index < 3 ? (cache.get(name) as ComposedPart) : await work();
      },
    });

    expect(replay.seen).toHaveLength(8);
    expect(replay.seen.some(hasFrames)).toBe(false);
    // Проход, отданный из кэша, не вызывает `compose`; живым остаются восемь, и все без кадров.
    expect(passes.map((pass) => pass.frames)).toEqual(Array(8).fill(0));
    expect(passes.every((pass) => pass.fallbacksLeft === 0)).toBe(true);
  });

  test("кадров нет вовсе — запросы прежние, участков без кадров не набирается", async () => {
    // Прежний конвейер кадров не присылает: этот случай не откат, а отсутствие кадров.
    const { composer, seen } = composerWith((request) => [
      section("Тема", request.part.startSeconds, request.part.endSeconds),
    ]);

    const { result } = await run(composer, { frames: [] });

    expect(seen).toHaveLength(11);
    expect(seen.some(hasFrames)).toBe(false);
    expect(result.withoutFrames).toEqual([]);
  });
});
