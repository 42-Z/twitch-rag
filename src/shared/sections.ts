/**
 * Разделы трансляции → куски для векторного поиска.
 *
 * Разделы приходят от модели готовой структурой (`openrouter.ts`), здесь они
 * приводятся к рабочему размеру и режутся на куски. Размер — не придирка:
 * слишком длинный раздел не влезает в метаданные куска, слишком короткий не
 * находится и не читается сам по себе.
 */


export interface ParsedSection {
  title: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  category: string;
}

export interface SectionChunk {
  chunkIndex: number;
  /** Текст, уходящий в эмбеддинг, — вместе с контекстной строкой. */
  text: string;
}

/** Текст раздела целиком дублируется в метаданных каждого куска и должен влезть в 48 КБ. */
export const MAX_SECTION_CHARS = 6000;
const MIN_CHUNK_CHARS = 1500;
const MAX_CHUNK_CHARS = 3000;
const CHUNK_OVERLAP_CHARS = 200;
/** Короче этого раздел не живёт сам по себе и склеивается с соседним. */
const MIN_SECTION_CHARS = 400;

/**
 * Приведение разделов к рабочему размеру.
 *
 * Модель ведёт себя неаккуратно предсказуемо: разделы выходят неравномерными.
 * Слишком длинные режутся по границам абзацев с пропорциональным делением
 * времени, слишком короткие склеиваются со следующим — содержание при этом
 * не теряется ни там, ни там.
 */
export function normalizeSections(sections: readonly ParsedSection[]): ParsedSection[] {
  const merged: ParsedSection[] = [];
  // Короткий раздел, которому некуда прирасти назад, ждёт следующего:
  // первый раздел документа иначе остался бы огрызком.
  let pending: ParsedSection | undefined;

  for (const section of sections) {
    let current: ParsedSection = { ...section };
    if (pending !== undefined) {
      current = {
        ...current,
        title: pending.title,
        text: `${pending.text}\n\n${current.text}`,
        startSeconds: pending.startSeconds,
      };
      pending = undefined;
    }

    if (current.text.length >= MIN_SECTION_CHARS) {
      merged.push(current);
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.text.length + current.text.length <= MAX_SECTION_CHARS) {
      previous.text = `${previous.text}\n\n${current.text}`;
      previous.endSeconds = current.endSeconds;
      continue;
    }
    pending = current;
  }

  if (pending !== undefined) merged.push(pending);

  return merged.flatMap(splitLongSection);
}

function splitLongSection(section: ParsedSection): ParsedSection[] {
  if (section.text.length <= MAX_SECTION_CHARS) return [section];

  const paragraphs = section.text.split(/\n{2,}/);
  const parts: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    const candidate = buffer === "" ? paragraph : `${buffer}\n\n${paragraph}`;
    if (candidate.length > MAX_SECTION_CHARS && buffer !== "") {
      parts.push(buffer);
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
  }
  if (buffer !== "") parts.push(buffer);

  const totalChars = parts.reduce((sum, part) => sum + part.length, 0);
  const span = section.endSeconds - section.startSeconds;
  let consumed = 0;

  return parts.map((text, index) => {
    const start = section.startSeconds + Math.round((span * consumed) / totalChars);
    consumed += text.length;
    const end =
      index === parts.length - 1
        ? section.endSeconds
        : section.startSeconds + Math.round((span * consumed) / totalChars);
    return {
      title: index === 0 ? section.title : `${section.title} (продолжение ${index + 1})`,
      text,
      startSeconds: start,
      endSeconds: end,
      category: section.category,
    };
  });
}

/**
 * Контекстная строка в начале куска: дата эфира, категория, тема раздела.
 * Без неё кусок, вырванный из документа, теряет привязку и хуже находится.
 */
export function buildContextLine(input: {
  publishedAt: string;
  category: string;
  sectionTitle: string;
}): string {
  const date = input.publishedAt.slice(0, 10);
  const category = input.category === "" ? "" : `, ${input.category}`;
  return `Стрим ${date}${category}. Тема: ${input.sectionTitle}.`;
}

/**
 * Раздел режется на куски 1500–3000 знаков с перекрытием 200.
 * Раздел короче нижней границы уходит в индекс целиком.
 */
export function chunkSection(section: ParsedSection, contextLine: string): SectionChunk[] {
  const pieces = splitWithOverlap(section.text);
  return pieces.map((text, chunkIndex) => ({
    chunkIndex,
    text: `${contextLine}\n\n${text}`,
  }));
}

function splitWithOverlap(text: string): string[] {
  if (text.length <= MIN_CHUNK_CHARS) return [text];

  const pieces: string[] = [];
  let position = 0;

  while (position < text.length) {
    const hardEnd = Math.min(position + MAX_CHUNK_CHARS, text.length);
    let end = hardEnd;

    if (hardEnd < text.length) {
      const earliest = position + MIN_CHUNK_CHARS;
      const boundary = lastBoundary(text, earliest, hardEnd);
      if (boundary > earliest) end = boundary;
    }

    pieces.push(text.slice(position, end).trim());
    if (end >= text.length) break;
    position = Math.max(end - CHUNK_OVERLAP_CHARS, position + 1);
  }

  return pieces.filter((piece) => piece.length > 0);
}

/** Последняя граница предложения или абзаца в окне — чтобы кусок не обрывался на полуслове. */
function lastBoundary(text: string, from: number, to: number): number {
  for (let index = to - 1; index > from; index--) {
    const char = text[index];
    if (char === "\n") return index + 1;
    if ((char === "." || char === "!" || char === "?") && text[index + 1] === " ") return index + 2;
  }
  return to;
}
