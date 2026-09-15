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

export interface MediaInfo {
  title: string;
  durationSeconds: number;
  /** Когда эфир прошёл, а не когда его разбирают. */
  publishedAt: string;
  /** Категории с временными границами — они же главы записи. */
  chapters: Chapter[];
}

/** Причина, по которой запись не будет разобрана, — текстом для человека. */
export interface Unavailable {
  code: "subscriber_only" | "not_found" | "geo_blocked" | "download_failed";
  message: string;
}

export class MediaUnavailableError extends Error {
  constructor(readonly reason: Unavailable) {
    super(reason.message);
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
  };

  const duration = Math.round(raw.duration ?? 0);
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
  };
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
