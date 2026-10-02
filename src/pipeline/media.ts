/**
 * Сведения о записи и её главы.
 *
 * Выполняется в боксе: `yt-dlp` — внешняя программа, в изоляте V8 её не
 * запустить. Здесь же выясняется то, чего не видно по API площадки: закрыта
 * ли запись для подписчиков.
 */

import { spawn } from "node:child_process";

export interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

/** Откуда брать кадры: плейлист видеодорожки и её высота. */
export interface FrameSource {
  playlistUrl: string;
  height: number;
}

export interface MediaInfo {
  title: string;
  durationSeconds: number;
  /** Когда эфир прошёл, а не когда его разбирают. */
  publishedAt: string;
  /** Категории с временными границами — они же главы записи. */
  chapters: Chapter[];
  /** Нет у записи без видео: кадров тогда нет, а звук берётся как раньше. */
  frameSource?: FrameSource;
}

/** Поля формата из `yt-dlp --dump-json`, по которым выбирается источник кадров. */
export interface RawFormat {
  format_id?: string;
  protocol?: string;
  height?: number | null;
  vcodec?: string | null;
  url?: string;
}

/** Выше этой высоты сегмент вдвое тяжелее, а модели всё равно уходит 1280 px. */
const FRAME_SOURCE_MAX_HEIGHT = 720;

/** Причина, по которой запись не будет разобрана, — текстом для человека. */
export interface Unavailable {
  code: "subscriber_only" | "not_found" | "geo_blocked" | "download_failed";
  message: string;
}

export class MediaUnavailableError extends Error {
  readonly reason: Unavailable;

  constructor(reason: Unavailable) {
    super(reason.message);
    this.reason = reason;
    this.name = "MediaUnavailableError";
  }
}

export async function readMediaInfo(url: string): Promise<MediaInfo> {
  const { stdout } = await run("yt-dlp", ["--dump-json", "--no-warnings", url]);
  const raw = JSON.parse(stdout) as {
    title?: string;
    duration?: number;
    timestamp?: number;
    upload_date?: string;
    chapters?: Array<{ title?: string; start_time?: number; end_time?: number }> | null;
    formats?: RawFormat[] | null;
  };

  const duration = Math.round(raw.duration ?? 0);
  const frameSource = pickFrameSource(raw.formats ?? []);
  const chapters = (raw.chapters ?? [])
    .map((chapter) => ({
      title: (chapter.title ?? "").trim(),
      startSeconds: Math.round(chapter.start_time ?? 0),
      endSeconds: Math.round(chapter.end_time ?? duration),
    }))
    .filter((chapter) => chapter.endSeconds > chapter.startSeconds);

  return {
    title: (raw.title ?? "").trim(),
    durationSeconds: duration,
    publishedAt: publishedAtOf(raw),
    // Эфир без смен категории глав не имеет — тогда категория одна на всю запись.
    chapters: chapters.length > 0 ? chapters : [{ title: "", startSeconds: 0, endSeconds: duration }],
    ...(frameSource === undefined ? {} : { frameSource }),
  };
}

/**
 * Источник кадров из форматов записи: плейлист HLS (`m3u8_native`) с видео.
 *
 * Берётся наибольшая высота не выше 720, а если таких нет — наименьшая выше.
 * Звук без видео и раскадровка площадки (`mhtml`, 160×90: текст не читается)
 * не годятся. Подходящих нет — кадров нет, и это не отказ: документ пишется по
 * речи. При равной высоте берётся формат, который `yt-dlp` называет позже: он
 * перечисляет форматы от худшего к лучшему (описание `formats` в
 * `yt_dlp/extractor/common.py`: «ordered from worst to best quality»).
 */
export function pickFrameSource(formats: readonly RawFormat[]): FrameSource | undefined {
  const candidates: FrameSource[] = [];
  for (const format of formats) {
    if (format.protocol !== "m3u8_native") continue;
    if (typeof format.url !== "string" || format.url === "") continue;
    if (typeof format.height !== "number" || !(format.height > 0)) continue;
    if (format.vcodec === "none") continue;
    candidates.push({ playlistUrl: format.url, height: format.height });
  }

  // Сортировка устойчивая: равные по высоте остаются в порядке списка.
  const byHeight = candidates.sort((a, b) => a.height - b.height);
  const fitting = byHeight.filter((candidate) => candidate.height <= FRAME_SOURCE_MAX_HEIGHT);
  return fitting.length > 0 ? fitting.at(-1) : byHeight[0];
}

/**
 * Дата эфира берётся из метаданных записи, а не из часов бокса: по ней
 * знания фильтруются по свежести, и подстановка времени разбора делает
 * годовалый эфир сегодняшним.
 */
export function publishedAtOf(raw: { timestamp?: number; upload_date?: string }): string {
  if (typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)) {
    return new Date(raw.timestamp * 1000).toISOString();
  }
  // Запасной вариант без времени суток: `upload_date` — это YYYYMMDD.
  const date = raw.upload_date ?? "";
  if (/^\d{8}$/.test(date)) {
    return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`).toISOString();
  }
  throw new Error("yt-dlp не сообщил дату эфира");
}

/**
 * Разбор жалобы `yt-dlp`. Причина нужна не ради красоты: запись, закрытую для
 * подписчиков, брать в работу больше не нужно, а временный сбой сети —
 * наоборот, нужно повторить.
 */
export function classifyFailure(stderr: string): Unavailable {
  const text = stderr.toLowerCase();
  if (text.includes("subscriber") || text.includes("subscribers only")) {
    return { code: "subscriber_only", message: "Запись доступна только подписчикам канала." };
  }
  if (text.includes("does not exist") || text.includes("not found") || text.includes("unavailable")) {
    return { code: "not_found", message: "Запись удалена или недоступна." };
  }
  if (text.includes("geo") || text.includes("blocked in your country")) {
    return { code: "geo_blocked", message: "Запись недоступна из этого региона." };
  }
  return { code: "download_failed", message: "Не удалось скачать запись." };
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Запуск внешней программы с чтением обоих потоков и внятной ошибкой. */
export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new MediaUnavailableError(classifyFailure(stderr)));
    });
  });
}

/**
 * Главы записи в пределах отрезка, время остаётся абсолютным.
 *
 * Часть эфира знает только свой отрезок, поэтому главы, которых в нём нет,
 * ей не нужны, а начавшаяся раньше — начинается на границе отрезка. Если ни
 * одна глава отрезка не коснулась, категория одна — пустая, на весь отрезок.
 */
export function clipChapters(chapters: readonly Chapter[], fromSeconds: number, toSeconds: number): Chapter[] {
  const clipped = chapters
    .map((chapter) => ({
      title: chapter.title,
      startSeconds: Math.max(chapter.startSeconds, fromSeconds),
      endSeconds: Math.min(chapter.endSeconds, toSeconds),
    }))
    .filter((chapter) => chapter.endSeconds > chapter.startSeconds);
  return clipped.length > 0 ? clipped : [{ title: "", startSeconds: fromSeconds, endSeconds: toSeconds }];
}
