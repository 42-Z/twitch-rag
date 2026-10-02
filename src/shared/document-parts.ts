/**
 * Сборка одного прохода документа: запрос к модели, переигровка на меньшем
 * участке при обрыве по потолку и переписывание без кадров при отказе по ним.
 *
 * Живёт вне Worker, хотя вызывается только оттуда, по одной причине: в модуле
 * разбора наверху стоит импорт `cloudflare:workers`, и ни одну его функцию
 * нельзя ни импортировать, ни проверить тестом. А здесь — вся проводка
 * запроса, включая те поля, которые приходят от владельца канала: пропадёт
 * поле по дороге, и заметить это можно было бы только живым разбором.
 */

import { AppError } from "./errors.ts";
import type { Chapter, TimeRange } from "./categories.ts";
import { MAX_FRAME_FALLBACKS, framesInRange, type Frame } from "./frames.ts";
import { isFramesRejection, type ComposedSection, type DocumentPartRequest } from "./openrouter.ts";

/**
 * Короче этого участок не дробится при обрыве по потолку: дробить дальше
 * нечего, а вызовы модели множатся. Вчетверо ниже длины прохода.
 */
const MIN_SPLIT_SECONDS = 300;
/** Сколько раз допускается разделить участок, прежде чем признать обрыв отказом. */
const MAX_SPLIT_DEPTH = 3;

/** Кто умеет писать проход. Ровно то, что нужно здесь от адаптера модели. */
export interface PartComposer {
  composeDocumentPart(request: DocumentPartRequest): Promise<ComposedSection[]>;
}

/** Всё, из чего собирается один запрос прохода. */
export interface PartComposition {
  transcript: string;
  part: { startSeconds: number; endSeconds: number };
  publishedAt: string;
  categories: ReadonlyArray<Chapter>;
  /** Сведения о стримере от владельца канала; пустая строка — не заполнено. */
  streamerInfo: string;
  /** Ключ закрепления за провайдером: у проходов одной записи он общий. */
  sessionId: string;
  /**
   * Кадры эфира, все. Проход берёт из них кадры своего участка (FR-004), а при
   * делении участка каждая половина — свои, поэтому сюда идёт полный список.
   */
  frames?: readonly Frame[];
}

/** Результат прохода: разделы и участки, где кадры были, но документ их не увидел. */
export interface ComposedPart {
  sections: ComposedSection[];
  /**
   * Участки, переписанные без кадров после отказа модели, и участки, которым
   * кадры не давались, потому что откаты уже исчерпаны. Пусто — кадры сработали
   * или их не было. По числу записей считаются откаты (`composePasses`).
   */
  withoutFrames: TimeRange[];
}

/** Сколько откатов без кадров ещё можно потратить; общий счёт на всё дерево деления одного прохода. */
interface FallbackBudget {
  left: number;
}

/**
 * Проход с переигровкой.
 *
 * Остановка по потолку означает неполный ответ, и повторять тот же запрос
 * бессмысленно: причиной был размер ответа, а не случайность. Участок поэтому
 * делится пополам, и каждая половина пишется отдельно.
 *
 * Отказ по кадрам (`isFramesRejection`) лечится иначе: тот же участок пишется
 * ещё раз **без кадров**, и он попадает в `withoutFrames`. Откат стоит одно
 * внешнее обращение, а обращений на прогон 50, поэтому откатов не больше
 * `fallbacksLeft` (по умолчанию `MAX_FRAME_FALLBACKS`): когда они кончились,
 * остальное пишется без кадров с самого начала. Отказ, не связанный с кадрами,
 * и повторная ошибка уже без них уходят наверх как есть: откатом они не лечатся.
 */
export async function composePart(
  composer: PartComposer,
  input: PartComposition,
  options: { fallbacksLeft?: number } = {},
): Promise<ComposedPart> {
  return await compose(composer, input, 0, { left: options.fallbacksLeft ?? MAX_FRAME_FALLBACKS });
}

async function compose(
  composer: PartComposer,
  start: PartComposition,
  depth: number,
  budget: FallbackBudget,
): Promise<ComposedPart> {
  let input = start;
  let frames = framesInRange(input.frames ?? [], input.part);
  const withoutFrames: TimeRange[] = [];

  if (frames.length > 0 && budget.left <= 0) {
    // Откаты кончились: кадры этому участку не даются вовсе, лишнего обращения
    // не будет. Без кадров и всё поддерево деления — иначе каждая половина
    // записала бы тот же участок ещё раз.
    withoutFrames.push({ startSeconds: input.part.startSeconds, endSeconds: input.part.endSeconds });
    input = { ...input, frames: [] };
    frames = [];
  }

  try {
    const sections = await composer.composeDocumentPart({
      fullTranscript: input.transcript,
      part: input.part,
      publishedAt: input.publishedAt,
      categories: input.categories,
      streamerInfo: input.streamerInfo,
      sessionId: input.sessionId,
      // Без кадров поле в запрос не попадает — он остаётся прежним.
      ...(frames.length === 0 ? {} : { frames }),
    });
    return { sections, withoutFrames };
  } catch (error) {
    if (frames.length > 0 && isFramesRejection(error)) {
      budget.left -= 1;
      // Причина уже в журнале адаптера; ссылки на кадры сюда не пишутся.
      console.warn(
        `участок ${input.part.startSeconds}–${input.part.endSeconds} с: модель отказалась от кадров, ` +
          `пишется по речи (откатов осталось ${budget.left})`,
      );
      const retried = await compose(composer, { ...input, frames: [] }, depth, budget);
      return {
        sections: retried.sections,
        withoutFrames: [
          { startSeconds: input.part.startSeconds, endSeconds: input.part.endSeconds },
          ...retried.withoutFrames,
        ],
      };
    }

    const span = input.part.endSeconds - input.part.startSeconds;
    const splittable =
      error instanceof AppError &&
      error.code === "output_truncated" &&
      depth < MAX_SPLIT_DEPTH &&
      span >= MIN_SPLIT_SECONDS * 2;
    if (!splittable) throw error;

    const middle = Math.round(input.part.startSeconds + span / 2);
    const first = await compose(
      composer,
      { ...input, part: { startSeconds: input.part.startSeconds, endSeconds: middle } },
      depth + 1,
      budget,
    );
    const second = await compose(
      composer,
      { ...input, part: { startSeconds: middle, endSeconds: input.part.endSeconds } },
      depth + 1,
      budget,
    );
    return {
      sections: [...first.sections, ...second.sections],
      withoutFrames: [...withoutFrames, ...first.withoutFrames, ...second.withoutFrames],
    };
  }
}

/** Что делает один проход: участок, кадры, которые ему можно дать, и сколько откатов осталось. */
export interface PassInput {
  part: TimeRange;
  /** Все кадры эфира, а при исчерпанных откатах — пустой список. Участок берёт из них свои. */
  frames: readonly Frame[];
  fallbacksLeft: number;
}

/**
 * Проходы подряд, каждый отдельным шагом, с предохранителем на откаты.
 *
 * Откат стоит обращение, а запас обращений на прогон ограничен: после
 * `MAX_FRAME_FALLBACKS` откатов оставшиеся проходы идут без кадров с самого
 * начала, а их участки с кадрами попадают в `withoutFrames` — запись скажет,
 * сколько эфира осталось без кадров. Счёт откатов выводится из результатов
 * прошлых шагов, а не хранится в переменной: при переигровке Workflow цикл
 * идёт заново, и состояние восстанавливается из кэша шагов.
 *
 * `step` — параметр: модуль разбора импортирует `cloudflare:workers` и в тестах
 * не подключается, а цикл от Workflow ничего другого не берёт.
 */
export async function composePasses(options: {
  parts: readonly TimeRange[];
  frames: readonly Frame[];
  step: (name: string, run: () => Promise<ComposedPart>) => Promise<ComposedPart>;
  stepName: (index: number, count: number) => string;
  compose: (pass: PassInput) => Promise<ComposedPart>;
}): Promise<ComposedPart> {
  const sections: ComposedSection[] = [];
  const withoutFrames: TimeRange[] = [];
  let fallbacks = 0;

  for (const [index, part] of options.parts.entries()) {
    const fallbacksLeft = MAX_FRAME_FALLBACKS - fallbacks;
    const frames = fallbacksLeft > 0 ? options.frames : [];
    if (frames.length === 0 && framesInRange(options.frames, part).length > 0) {
      withoutFrames.push({ startSeconds: part.startSeconds, endSeconds: part.endSeconds });
    }

    const composed = await options.step(options.stepName(index, options.parts.length), () =>
      options.compose({ part, frames, fallbacksLeft }),
    );
    sections.push(...composed.sections);
    withoutFrames.push(...composed.withoutFrames);
    fallbacks += composed.withoutFrames.length;
  }
  return { sections, withoutFrames };
}
