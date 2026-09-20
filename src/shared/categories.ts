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

/** Участок эфира в секундах от его начала. */
export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Границы участков для многопроходного составления документа.
 *
 * Выход модели ограничен 32 768 токенами, поэтому документ пишется в
 * несколько проходов. Границы выравниваются по сменам категории — там всё
 * равно меняется тема, и шов документа приходится на естественный разрыв.
 *
 * Участок — отрезок эфира, а не длительность: у части, начинающейся не с
 * нуля, время в расшифровке абсолютное, и проходы обязаны лежать внутри
 * отрезка. Считать «от нуля до длительности» значило бы строить проходы по
 * времени, которого в расшифровке части нет.
 */
export function planDocumentParts(range: TimeRange, chapters: readonly Chapter[], partCount: number): TimeRange[] {
  if (partCount <= 1) return [{ startSeconds: range.startSeconds, endSeconds: range.endSeconds }];

  const idealSpan = (range.endSeconds - range.startSeconds) / partCount;
  const boundaries: number[] = [range.startSeconds];

  for (let index = 1; index < partCount; index++) {
    const ideal = range.startSeconds + idealSpan * index;
    const previous = boundaries[boundaries.length - 1] ?? range.startSeconds;
    const candidates = chapters
      .map((chapter) => chapter.startSeconds)
      .filter((start) => start > previous && start < range.endSeconds);
    const nearest = candidates.reduce<number | undefined>((best, start) => {
      if (best === undefined) return start;
      return Math.abs(start - ideal) < Math.abs(best - ideal) ? start : best;
    }, undefined);

    // Смена категории годится как шов, только если она близка к идеальной
    // границе: иначе участки выйдут слишком разными и один не влезет в выход.
    const useChapter = nearest !== undefined && Math.abs(nearest - ideal) < idealSpan / 2;
    boundaries.push(Math.round(useChapter && nearest !== undefined ? nearest : ideal));
  }
  boundaries.push(range.endSeconds);

  const parts: TimeRange[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index] ?? range.startSeconds;
    const end = boundaries[index + 1] ?? range.endSeconds;
    if (end > start) parts.push({ startSeconds: start, endSeconds: end });
  }
  return parts;
}

/** Разрыв больше этого означает пропущенный участок эфира, а не паузу в речи. */
const MAX_COVERAGE_GAP_SECONDS = 300;

/**
 * Участки отрезка эфира, не покрытые ни одним разделом (FR-040).
 *
 * Отсчёт идёт от начала отрезка, а не от нуля: у второй части эфира иначе
 * всё, что до её начала, объявилось бы разрывом.
 */
export function findCoverageGaps(
  sections: readonly ParsedSection[],
  range: TimeRange,
): Array<{ from: number; to: number }> {
  const ordered = [...sections].sort((a, b) => a.startSeconds - b.startSeconds);
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = range.startSeconds;

  for (const section of ordered) {
    if (section.startSeconds - cursor > MAX_COVERAGE_GAP_SECONDS) {
      gaps.push({ from: cursor, to: section.startSeconds });
    }
    cursor = Math.max(cursor, section.endSeconds);
  }
  if (range.endSeconds - cursor > MAX_COVERAGE_GAP_SECONDS) {
    gaps.push({ from: cursor, to: range.endSeconds });
  }
  return gaps;
}
