/**
 * Скачивание звуковой дорожки и нарезка её на куски.
 *
 * `yt-dlp` отдаёт поток в `ffmpeg`, тот пережимает и режет на лету: полный
 * файл на диск не ложится. AAC 32 кбит/с моно — вдвое быстрее opus по
 * процессорному времени, а при лимите 25 МБ на файл оставляет десятикратный
 * запас.
 *
 * Куски по двадцать минут (`AUDIO_CHUNK_SECONDS`): у распознавания 60 секунд на
 * запрос, часовой кусок в этот срок не укладывается, а двадцатиминутный
 * отвечает за 11,7 с. Размер выбран не только под время ответа: число
 * кусков — слагаемое лимита внешних обращений на прогон разбора, и он же
 * задаёт порог деления эфира (`shared/stream-parts.ts`).
 *
 * Качается только нужный отрезок записи (`--download-sections`): часть эфира
 * разбирается отдельным прогоном и остальных частей не касается. Флаг
 * `--force-keyframes-at-cuts` не используется — он вдвое увеличивает
 * процессорное время бокса (замер в `specs/006-split-long-streams/research.md`).
 * Нарезка отрезка считает время от нуля, поэтому смещения кусков приводятся
 * ко времени всего эфира (`absoluteChunks`).
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AUDIO_CHUNK_SECONDS } from "../shared/stream-parts.ts";

export interface AudioChunk {
  index: number;
  /** Имя файла внутри рабочего каталога. */
  file: string;
  offsetSeconds: number;
  durationSeconds: number;
}

/** Границы отрезка записи, секунды от начала эфира. */
export interface AudioRange {
  fromSeconds: number;
  toSeconds: number;
}

/** Аргумент `--download-sections`: `*01:00:00-01:32:00`, как в проверенной команде. */
export function formatSection(fromSeconds: number, toSeconds: number): string {
  return `*${clock(fromSeconds)}-${clock(toSeconds)}`;
}

function clock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Смещения кусков — от начала эфира, а не от начала отрезка. */
export function absoluteChunks(chunks: readonly AudioChunk[], fromSeconds: number): AudioChunk[] {
  return chunks.map((chunk) => ({ ...chunk, offsetSeconds: chunk.offsetSeconds + fromSeconds }));
}

export async function cutAudio(url: string, workDir: string, range: AudioRange): Promise<AudioChunk[]> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const indexPath = path.join(workDir, "index.csv");
  const pattern = path.join(workDir, "chunk_%04d.m4a");

  await pipeThrough(
    [
      "yt-dlp",
      [
        "-f", "bestaudio",
        "--no-part", "--no-warnings",
        "--download-sections", formatSection(range.fromSeconds, range.toSeconds),
        "-o", "-",
        url,
      ],
    ],
    [
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000",
        "-f", "segment",
        "-segment_time", String(AUDIO_CHUNK_SECONDS),
        "-reset_timestamps", "1",
        "-segment_list", indexPath,
        "-segment_list_type", "csv",
        pattern,
      ],
    ],
  );

  return await readIndex(indexPath);
}

/**
 * `segment_list_type csv` даёт строки вида `chunk_0000.m4a,0.000000,600.000000` —
 * готовые границы, по которым метки куска приводятся ко времени всей записи.
 */
export async function readIndex(indexPath: string): Promise<AudioChunk[]> {
  const text = await readFile(indexPath, "utf8");
  const chunks: AudioChunk[] = [];

  for (const line of text.split("\n")) {
    const parts = line.trim().split(",");
    if (parts.length < 3) continue;
    const [file, start, end] = parts;
    if (file === undefined || start === undefined || end === undefined) continue;

    const offsetSeconds = Number(start);
    const endSeconds = Number(end);
    if (!Number.isFinite(offsetSeconds) || !Number.isFinite(endSeconds)) continue;

    chunks.push({
      index: chunks.length,
      file: path.basename(file),
      offsetSeconds,
      durationSeconds: endSeconds - offsetSeconds,
    });
  }

  return chunks;
}

/** Два процесса в конвейере: вывод первого — вход второго, без промежуточного файла. */
function pipeThrough(
  first: [string, string[]],
  second: [string, string[]],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = spawn(first[0], first[1], { stdio: ["ignore", "pipe", "pipe"] });
    const sink = spawn(second[0], second[1], { stdio: ["pipe", "ignore", "pipe"] });

    let sourceErrors = "";
    let sinkErrors = "";
    source.stderr.on("data", (chunk: Buffer) => (sourceErrors += chunk.toString()));
    sink.stderr.on("data", (chunk: Buffer) => (sinkErrors += chunk.toString()));

    source.stdout.pipe(sink.stdin);
    source.on("error", reject);
    sink.on("error", reject);

    // Ошибка скачивания важнее ошибки нарезки: без данных резать нечего,
    // и жалоба ffmpeg на оборванный поток только уводит от причины.
    source.on("close", (code) => {
      if (code !== 0) reject(new Error(sourceErrors || `yt-dlp завершился с кодом ${code}`));
    });
    sink.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(sinkErrors || sourceErrors || `ffmpeg завершился с кодом ${code}`));
    });
  });
}
