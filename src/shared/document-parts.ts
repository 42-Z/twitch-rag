/**
 * Сборка одного прохода документа: запрос к модели и переигровка на меньшем
 * участке при обрыве по потолку.
 *
 * Живёт вне Worker, хотя вызывается только оттуда, по одной причине: в модуле
 * разбора наверху стоит импорт `cloudflare:workers`, и ни одну его функцию
 * нельзя ни импортировать, ни проверить тестом. А здесь — вся проводка
 * запроса, включая те поля, которые приходят от владельца канала: пропадёт
 * поле по дороге, и заметить это можно было бы только живым разбором.
 */

import { AppError } from "./errors.ts";
import type { Chapter } from "./categories.ts";
import type { ComposedSection, DocumentPartRequest } from "./openrouter.ts";

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
}

/**
 * Проход с переигровкой на меньшем участке.
 *
 * Остановка по потолку означает неполный ответ, и повторять тот же запрос
 * бессмысленно: причиной был размер ответа, а не случайность. Участок поэтому
 * делится пополам, и каждая половина пишется отдельно. Отказ модели и
 * недоступность сервиса так не лечатся — они уходят наверх как есть.
 */
export async function composePart(
  composer: PartComposer,
  input: PartComposition,
  depth = 0,
): Promise<ComposedSection[]> {
  try {
    return await composer.composeDocumentPart({
      fullTranscript: input.transcript,
      part: input.part,
      publishedAt: input.publishedAt,
      categories: input.categories,
      streamerInfo: input.streamerInfo,
      sessionId: input.sessionId,
    });
  } catch (error) {
    const span = input.part.endSeconds - input.part.startSeconds;
    const splittable =
      error instanceof AppError &&
      error.code === "output_truncated" &&
      depth < MAX_SPLIT_DEPTH &&
      span >= MIN_SPLIT_SECONDS * 2;
    if (!splittable) throw error;

    const middle = Math.round(input.part.startSeconds + span / 2);
    const first = await composePart(
      composer,
      { ...input, part: { startSeconds: input.part.startSeconds, endSeconds: middle } },
      depth + 1,
    );
    const second = await composePart(
      composer,
      { ...input, part: { startSeconds: middle, endSeconds: input.part.endSeconds } },
      depth + 1,
    );
    return [...first, ...second];
  }
}
