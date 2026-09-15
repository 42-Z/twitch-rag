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

/** Обратная операция к `formatClock`: `1:12:30` и `12:30` в секунды. */
export function parseClock(clock: string): number {
  const parts = clock.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Не удалось разобрать время: «${clock}»`);
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Метки куска приводятся ко времени всей записи. Куски режутся с перекрытием,
 * поэтому у соседей края накладываются — это снимается при склейке.
 */
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
 * Куски перекрываются пятью секундами, чтобы не потерять фразу на стыке;
 * из-за этого одна и та же фраза приходит дважды. Дубликат отбрасывается по
 * совпадению текста в зоне перекрытия, а не по одному лишь времени: границы
 * сегментов у соседних кусков не совпадают точно.
 */
export function mergeTranscripts(chunks: readonly TranscriptSegment[][]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const chunk of chunks) {
    for (const segment of chunk) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && segment.start < previous.end) {
        const sameText = normalizeForCompare(previous.text) === normalizeForCompare(segment.text);
        if (sameText) continue;
      }
      merged.push(segment);
    }
  }
  return merged;
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
