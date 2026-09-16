/**
 * Скачивание звуковой дорожки и нарезка её на куски.
 *
 * `yt-dlp` отдаёт поток в `ffmpeg`, тот пережимает и режет на лету: полный
 * файл на диск не ложится. AAC 32 кбит/с моно — вдвое быстрее opus по
 * процессорному времени, а при лимите 25 МБ на файл оставляет десятикратный
 * запас.
 *
 * Куски по десять минут, потому что у распознавания 60 секунд на запрос:
 * часовой кусок в этот срок не укладывается.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const CHUNK_SECONDS = 600;

export interface AudioChunk {
  index: number;
  /** Имя файла внутри рабочего каталога. */
  file: string;
  offsetSeconds: number;
  durationSeconds: number;
}

export async function cutAudio(url: string, workDir: string): Promise<AudioChunk[]> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const indexPath = path.join(workDir, "index.csv");
  const pattern = path.join(workDir, "chunk_%04d.m4a");

  await pipeThrough(
    ["yt-dlp", ["-f", "bestaudio", "--no-part", "--no-warnings", "-o", "-", url]],
    [
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000",
        "-f", "segment",
        "-segment_time", String(CHUNK_SECONDS),
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
