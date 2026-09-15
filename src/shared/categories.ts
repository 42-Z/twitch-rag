/**
 * Категория трансляции на момент разговора.
 *
 * Стример меняет категорию по ходу эфира, поэтому у знания должна стоять та,
 * что была в его момент, а не та, что осталась в конце. Категории берутся из
 * глав записи — данных площадки, а не из содержания речи.
 */

import type { ParsedSection } from "./sections.ts";

export interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

/** Категория, действовавшая в указанную секунду эфира. */
export function categoryAt(chapters: readonly Chapter[], seconds: number): string {
  const exact = chapters.find(
    (chapter) => seconds >= chapter.startSeconds && seconds < chapter.endSeconds,
  );
  if (exact !== undefined) return exact.title;

  // Момент вне известных глав — берётся ближайшая предыдущая, иначе первая.
  const earlier = chapters.filter((chapter) => chapter.startSeconds <= seconds);
  const fallback = earlier[earlier.length - 1] ?? chapters[0];
  return fallback?.title ?? "";
}

/**
 * Разделам проставляются категории по времени начала. Категория, которую
 * модель уже вписала в заголовок, не перетирается: это её прочтение эфира,
 * и оно ближе к содержанию, чем механическое попадание во время.
 */
export function assignCategories(
  sections: readonly ParsedSection[],
  chapters: readonly Chapter[],
): ParsedSection[] {
  return sections.map((section) => ({
    ...section,
    category: section.category !== "" ? section.category : categoryAt(chapters, section.startSeconds),
  }));
}

/** Категории эфира без повторов, в порядке появления — для реестра и статистики. */
export function uniqueCategories(chapters: readonly Chapter[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const chapter of chapters) {
    if (chapter.title === "" || seen.has(chapter.title)) continue;
    seen.add(chapter.title);
    result.push(chapter.title);
  }
  return result;
}

/**
 * Границы участков для многопроходного составления документа.
 *
 * Выход модели ограничен 32 768 токенами, поэтому документ пишется в
 * несколько проходов. Границы выравниваются по сменам категории — там всё
 * равно меняется тема, и шов документа приходится на естественный разрыв.
 */
export function planDocumentParts(
  durationSeconds: number,
  chapters: readonly Chapter[],
  partCount: number,
): Array<{ startSeconds: number; endSeconds: number }> {
  if (partCount <= 1) return [{ startSeconds: 0, endSeconds: durationSeconds }];

  const idealSpan = durationSeconds / partCount;
  const boundaries: number[] = [0];

  for (let index = 1; index < partCount; index++) {
    const ideal = idealSpan * index;
    const previous = boundaries[boundaries.length - 1] ?? 0;
    const candidates = chapters
      .map((chapter) => chapter.startSeconds)
      .filter((start) => start > previous && start < durationSeconds);
    const nearest = candidates.reduce<number | undefined>((best, start) => {
      if (best === undefined) return start;
      return Math.abs(start - ideal) < Math.abs(best - ideal) ? start : best;
    }, undefined);

    // Смена категории годится как шов, только если она близка к идеальной
    // границе: иначе участки выйдут слишком разными и один не влезет в выход.
    const useChapter = nearest !== undefined && Math.abs(nearest - ideal) < idealSpan / 2;
    boundaries.push(Math.round(useChapter && nearest !== undefined ? nearest : ideal));
  }
  boundaries.push(durationSeconds);

  const parts: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? durationSeconds;
    if (end > start) parts.push({ startSeconds: start, endSeconds: end });
  }
  return parts;
}
