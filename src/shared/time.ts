/**
 * Время внутри записи: разбор длительности Twitch, ссылки на момент эфира,
 * приведение меток куска ко времени всей записи.
 *
 * Правило конвейера: смещение куска прибавляется к меткам сегментов сразу
 * после распознавания, поэтому дальше время всегда отсчитывается от начала
 * записи, а не от начала куска.
 */

/**
 * Helix отдаёт длительность строкой вида `7h12m35s`; части могут отсутствовать
 * (`45m`, `12s`, `1h30s`).
 */
export function parseTwitchDuration(duration: string): number {
  const match = duration.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || match[0] === "") {
    throw new Error(`Не удалось разобрать длительность записи: «${duration}»`);
  }
  const [, hours, minutes, seconds] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/** Момент записи в формате ссылки Twitch: `1h2m3s`. */
export function toTwitchTimecode(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return `${hours}h${minutes}m${seconds}s`;
}

/** Ссылка на запись с таймкодом — то, что уходит клиенту вместе с разделом. */
export function vodUrlAt(vodId: string, startSeconds: number): string {
  return `https://www.twitch.tv/videos/${vodId}?t=${toTwitchTimecode(startSeconds)}`;
}

/**
 * Длительность словами: «5 ч 17 мин», «40 мин», «меньше минуты».
 *
 * Остаток считается от округлённых минут, а не от секунд: иначе 3591 секунда
 * давала бы «60 мин», а 7195 — «1 ч 60 мин».
 */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(Math.max(0, totalSeconds) / 60);
  if (minutes === 0) return "меньше минуты";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Человекочитаемое время внутри эфира: `1:12:30` или `12:30`. */
export function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Метки куска приводятся ко времени всей записи. */
export function shiftSegments(segments: readonly TranscriptSegment[], offsetSeconds: number): TranscriptSegment[] {
  return segments.map((segment) => ({
    start: segment.start + offsetSeconds,
    end: segment.end + offsetSeconds,
    text: segment.text,
  }));
}

/**
 * Склейка распознанных кусков в сплошную расшифровку.
 *
 * Куски режутся встык, без наложения, поэтому склейка — это сложение подряд.
 * Фраза, попавшая точно на стык, может распознаться половинками: это
 * известная плата за нарезку одним проходом (`segment.ts`), а не повод
 * что-то выбрасывать при склейке.
 */
export function mergeTranscripts(chunks: readonly TranscriptSegment[][]): TranscriptSegment[] {
  return chunks.flat();
}

/** Язык, выпавший на большинстве кусков; пустые определения не в счёт. */
export function prevailingLanguage(languages: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const raw of languages) {
    const language = raw.trim().toLowerCase();
    if (language === "") continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}
