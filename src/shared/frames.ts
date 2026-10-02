/**
 * Кадры эфира: интервал, окна, выбор кадров для прохода.
 *
 * Одно понятие кадра на обе стороны: конвейер в боксе решает по нему, откуда
 * брать кадры, а Worker — какие из них показать проходу и сколько эфира
 * осталось без кадров. Если бы окна считались в двух местах, расхождение
 * выглядело бы как потерянные кадры. Файл не зависит ни от `cloudflare:workers`,
 * ни от `node:*`: его читают бокс, Worker и стенд.
 *
 * Кадр — только добавка к расшифровке: разделы и их время идут по речи.
 * Любая неудача кадра пропускает этот кадр, а не разбор.
 * Расчёты и замеры: `specs/007-stream-frames/research.md`.
 */

import type { TimeRange } from "./categories.ts";
import { formatDuration } from "./time.ts";

/**
 * Один кадр на столько секунд эфира (FR-002). Единственное место значения:
 * его читают и конвейер, и Worker. Если оно когда-нибудь меняется, обе стороны
 * выпускаются одной парой — при расхождении окна считаются по-разному, и
 * пометка «без кадров» покажет лишнее.
 */
export const FRAME_INTERVAL_SECONDS = 180;

/**
 * Больше картинок в один запрос модель не принимает: 51-я даёт HTTP 400
 * ([Meta: Multiple images](https://dev.meta.ai/docs/image-understanding)).
 * Жёсткий предел сборки запроса, а не цель: штатно проход держится ниже
 * (`MAX_FRAMES_PER_PASS`).
 */
export const MAX_FRAMES_PER_REQUEST = 50;

/**
 * Сколько кадров на проход допускается при расчёте числа проходов. Участок
 * прохода выравнивается по сменам категории и выходит в полтора раза длиннее
 * среднего, поэтому 30 × 1,5 = 45 — запас до 50 (`research.md` §7).
 */
export const MAX_FRAMES_PER_PASS = 30;

/**
 * Сколько раз на часть эфира проход переписывается без кадров после отказа.
 *
 * Откат стоит одно внешнее обращение, а прогон Workflow даёт их 50. Худшее
 * сочетание `006` — 46 (`shared/stream-parts.ts`), запас 50 − 46 = 4, откатов
 * не больше трёх: 46 + 3 = 49. После третьего оставшиеся проходы идут без
 * кадров с самого начала и лишних обращений не тратят (`research.md` §5).
 */
export const MAX_FRAME_FALLBACKS = 3;

/**
 * Каталог кадров в хранилище аудио: `frames/<streamId>/…`. Кадры кладёт бокс
 * (`pipeline/publish.ts`), а убирает Worker (`worker/temporary.ts`) — оба берут
 * префикс отсюда, поэтому раскладка и уборка не могут разойтись: расхождение
 * оставило бы в хранилище кадры с лицами и никами зрителей.
 */
export const FRAMES_PREFIX = "frames/";

/** Изображение экрана эфира в один момент. */
export interface Frame {
  /**
   * Начало сегмента, из которого снят кадр: абсолютное время от начала эфира,
   * как `offsetSeconds` кусков. Не расчётный момент окна — подпись честная.
   */
  atSeconds: number;
  /** Подписанная ссылка на чтение объекта в R2: носитель доступа, в журнал не пишется. */
  url: string;
}

/** Окно эфира, из которого берётся один кадр. */
export interface FrameWindow {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** Расчётный момент — середина окна, целая секунда вниз. */
  momentSeconds: number;
}

/**
 * Окна кадров отрезка: `n = max(1, round(L ÷ 180))` окон равной длины, `k`-е —
 * `[from + k·L/n, from + (k+1)·L/n)`.
 *
 * Равные окна исключают хвост короче интервала: иначе у каждой записи была бы
 * «неполная» последняя минута, и пометка «без кадров» стояла бы на каждой.
 * Середина окна — наибольшее расстояние до любого момента окна, 90 с, а не 180.
 * Для эфира в 20 789 с получается 115 окон, для части в 21 600 с — 120.
 * Пустой, обратный и нечисловой отрезок окон не даёт.
 */
export function frameWindows(range: TimeRange): FrameWindow[] {
  const length = range.endSeconds - range.startSeconds;
  if (!Number.isFinite(length) || length <= 0) return [];

  const count = Math.max(1, Math.round(length / FRAME_INTERVAL_SECONDS));
  // Общая граница соседних окон считается одним выражением, а последняя —
  // ровно концом отрезка: сумма длин окон равна длине без накопленной ошибки.
  const boundary = (position: number): number =>
    position === count ? range.endSeconds : range.startSeconds + (position * length) / count;

  return Array.from({ length: count }, (_, index) => {
    const startSeconds = boundary(index);
    const endSeconds = boundary(index + 1);
    return { index, startSeconds, endSeconds, momentSeconds: Math.floor((startSeconds + endSeconds) / 2) };
  });
}

/**
 * Кадры участка: подпись внутри `[start, end)`, по возрастанию. Проход видит
 * только кадры своего участка (FR-004): чужие ему не нужны и занимают предел
 * картинок.
 */
export function framesInRange(frames: readonly Frame[], range: TimeRange): Frame[] {
  return frames
    .filter((frame) => frame.atSeconds >= range.startSeconds && frame.atSeconds < range.endSeconds)
    .sort((a, b) => a.atSeconds - b.atSeconds);
}

/**
 * Не больше `max` кадров. При избытке — равномерная выборка с первым и
 * последним кадром, а не обрезка с хвоста: иначе конец участка остался бы
 * совсем без кадров. Ожидает кадры по возрастанию, как их отдаёт `framesInRange`.
 */
export function limitFrames(frames: readonly Frame[], max: number = MAX_FRAMES_PER_REQUEST): Frame[] {
  if (max <= 0) return [];
  if (frames.length <= max) return [...frames];

  const step = max === 1 ? 0 : (frames.length - 1) / (max - 1);
  // Шаг больше единицы, поэтому округлённые позиции не совпадают.
  return Array.from({ length: max }, (_, position) => frames[Math.round(position * step)] as Frame);
}

/**
 * Сколько проходов нужно, чтобы на проход пришлось не больше
 * `MAX_FRAMES_PER_PASS` кадров. Число проходов не меньше этого, как бы мало
 * речи ни было: иначе у эфира с редкой речью на проход пришлось бы больше
 * картинок, чем принимает запрос.
 */
export function minPassesForFrames(frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.ceil(frameCount / MAX_FRAMES_PER_PASS);
}

/**
 * Сколько эфира осталось без кадров: сумма длин окон, которые не покрыты (FR-015).
 *
 * Окно покрыто, если в нём есть кадр и этот кадр не лежит ни в одном из
 * `withoutFrames` — участков, которые проход переписал без кадров после отказа
 * модели: кадр там был, но документ его не видел. Кадров нет вовсе (прежний
 * конвейер, запись без видео, сбой добычи) — не покрыто всё, и результат равен
 * длине отрезка.
 */
export function framelessSeconds(
  range: TimeRange,
  frames: readonly Frame[],
  withoutFrames: readonly TimeRange[] = [],
): number {
  const lost = (frame: Frame): boolean =>
    withoutFrames.some((span) => frame.atSeconds >= span.startSeconds && frame.atSeconds < span.endSeconds);

  let uncovered = 0;
  for (const window of frameWindows(range)) {
    const covered = frames.some(
      (frame) => frame.atSeconds >= window.startSeconds && frame.atSeconds < window.endSeconds && !lost(frame),
    );
    if (!covered) uncovered += window.endSeconds - window.startSeconds;
  }
  return Math.round(uncovered);
}

/** «Без кадров: 40 мин эфира.» — пометка для записи; когда нечего сказать, пустая строка. */
export function formatFramelessNote(seconds: number): string {
  return seconds > 0 ? `Без кадров: ${formatDuration(seconds)} эфира.` : "";
}

/**
 * Причина в записи: пометка о разрывах покрытия и пометка о кадрах через пробел.
 * Пустые отбрасываются; обе пустые — пустая строка, как и раньше, чтобы на
 * разобранной записи не висела причина отказа прошлой попытки.
 */
export function composeReason(gapsNote: string, framelessNote: string): string {
  return [gapsNote, framelessNote].filter((note) => note !== "").join(" ");
}
