/**
 * Проверка 1: настоящая расшифровка участка записи.
 *
 * Берётся запись канала, из неё вырезается участок, режется на десятиминутные
 * куски и распознаётся так же, как в разборе: та же модель, тот же формат
 * ответа, те же метки сегментов, приведённые ко времени записи.
 *
 * На выходе — расшифровка в том виде, в каком её видит модель, и сведения о
 * распознавании. Это входной материал для остальных проверок: живая речь с
 * ошибками распознавания, заминками и музыкой, а не письменный текст.
 *
 * Запуск:
 *   node --env-file=.env specs/002-document-quality/research/scripts/transcript.ts \
 *     --vod 2875806701 --from 20:00 --to 90:00
 *
 * Нужны во внешнем окружении: OPENROUTER_API_KEY, а также yt-dlp и ffmpeg.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { readIndex } from "../../../../src/pipeline/segment.ts";
import { shiftSegments, prevailingLanguage, type TranscriptSegment } from "../../../../src/shared/time.ts";

const API = "https://openrouter.ai/api/v1/audio/transcriptions";
/** Те же значения, что в `src/shared/openrouter.ts`: иначе замер мерил бы не то. */
const MODEL = "openai/whisper-large-v3-turbo";
const CHUNK_SECONDS = 600;

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`нужен --${name}`);
  return value;
}

function clock(value: string): number {
  const parts = value.split(":").map(Number);
  const [hours = 0, minutes = 0, seconds = 0] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return hours * 3600 + minutes * 60 + seconds;
}

const execFileAsync = promisify(execFile);

/** Запуск программы с выводом в память; вывод yt-dlp о записи — десятки килобайт. */
async function capture(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failed = error as { code?: number | string; stderr?: string };
    throw new Error(`${command} завершился с кодом ${failed.code}: ${(failed.stderr ?? "").slice(-800)}`);
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await capture(command, args);
}

const vod = arg("vod");
const from = clock(arg("from"));
const to = clock(arg("to"));
const key = process.env["OPENROUTER_API_KEY"] ?? "";
if (key === "") throw new Error("нет OPENROUTER_API_KEY");

const researchDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(researchDir, "data");
const workDir = path.join(dataDir, "work", vod);
await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

const label = `${vod}-${from}-${to}`;
const url = `https://www.twitch.tv/videos/${vod}`;

// Сведения о записи: название нужно проверкам промпта, главы — категориям.
console.log("сведения о записи…");
const infoRaw = JSON.parse(await capture("yt-dlp", ["--dump-json", "--no-warnings", url])) as {
  title?: string;
  duration?: number;
  timestamp?: number;
  chapters?: Array<{ title?: string; start_time?: number; end_time?: number }> | null;
};
const duration = Math.round(infoRaw.duration ?? 0);
const chapters = (infoRaw.chapters ?? []).map((chapter) => ({
  title: (chapter.title ?? "").trim(),
  startSeconds: Math.round(chapter.start_time ?? 0),
  endSeconds: Math.round(chapter.end_time ?? duration),
}));

// Скачивается только участок: целая запись тут не нужна.
console.log(`скачивание ${arg("from")}–${arg("to")}…`);
await run("yt-dlp", [
  "--no-playlist", "--no-warnings",
  "--download-sections", `*${arg("from")}-${arg("to")}`,
  "-f", "bestaudio", "-o", path.join(workDir, "section.%(ext)s"), url,
]);

// Нарезка повторяет `src/pipeline/segment.ts`: AAC 32 кбит/с моно, по десять минут.
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-i", path.join(workDir, "section.mp4"),
  "-vn", "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000",
  "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
  "-reset_timestamps", "1",
  "-segment_list", path.join(workDir, "index.csv"), "-segment_list_type", "csv",
  path.join(workDir, "chunk_%04d.m4a"),
]);
const chunks = await readIndex(path.join(workDir, "index.csv"));
console.log(`кусков: ${chunks.length}`);

const languages: string[] = [];
const segments: TranscriptSegment[] = [];
const chunkReports: unknown[] = [];

for (const chunk of chunks) {
  const audio = await readFile(path.join(workDir, chunk.file));
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mp4" }), `chunk-${chunk.index}.m4a`);
  form.append("model", MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const started = Date.now();
  const response = await fetch(API, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!response.ok) throw new Error(`распознавание ${chunk.index}: ${response.status} ${await response.text()}`);
  const raw = (await response.json()) as {
    text: string;
    language: string;
    duration: number;
    segments?: Array<{ start: number; end: number; text: string }>;
    usage?: unknown;
  };

  const found = (raw.segments ?? [])
    .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text.trim() }))
    .filter((segment) => segment.text !== "");
  // Смещение участка плюс смещение куска: дальше время везде от начала записи.
  segments.push(...shiftSegments(found, from + chunk.offsetSeconds));
  languages.push(raw.language);
  chunkReports.push({
    index: chunk.index,
    offsetSeconds: chunk.offsetSeconds,
    seconds: raw.duration,
    language: raw.language,
    phrases: found.length,
    usage: raw.usage ?? null,
    milliseconds: Date.now() - started,
  });
  console.log(`  кусок ${chunk.index + 1} из ${chunks.length}: ${found.length} фраз, ${Math.round(raw.duration)} с`);
}

const rendered = segments.map((segment) => `[${Math.round(segment.start)}] ${segment.text}`).join("\n");
const speechSeconds = Math.round(segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0));

const report = {
  vod,
  url,
  title: (infoRaw.title ?? "").trim(),
  publishedAt: new Date((infoRaw.timestamp ?? 0) * 1000).toISOString(),
  durationSeconds: duration,
  section: { from, to, seconds: to - from },
  language: prevailingLanguage(languages),
  chunks: chunkReports,
  phrases: segments.length,
  speechSeconds,
  transcriptChars: rendered.length,
  charsPerMinuteOfSection: Math.round(rendered.length / ((to - from) / 60)),
  charsPerMinuteOfSpeech: Math.round(rendered.length / (speechSeconds / 60)),
  chapters,
  measuredAt: new Date().toISOString(),
};

await writeFile(path.join(dataDir, `transcript-${label}.txt`), rendered);
await writeFile(path.join(dataDir, `transcript-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
await rm(workDir, { recursive: true, force: true });

console.log(`\nрасшифровка: ${rendered.length} знаков, ${segments.length} фраз, язык ${report.language}`);
console.log(`знаков в минуте участка: ${report.charsPerMinuteOfSection}, в минуте речи: ${report.charsPerMinuteOfSpeech}`);
console.log(`сохранено: data/transcript-${label}.txt и .json`);
