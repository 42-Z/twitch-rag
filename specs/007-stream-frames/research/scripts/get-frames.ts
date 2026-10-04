/**
 * Кадры участка записи — тем же кодом, что в конвейере: источник из `formats`,
 * плейлист, сегмент по середине окна, `ffmpeg`. Отличается только хранилище:
 * вместо R2 кадры ложатся в каталог, и ссылка на кадр — имя файла.
 *
 *   node --env-file=.env specs/007-stream-frames/research/scripts/get-frames.ts \
 *     --vod 2875806701 --from 1200 --to 5400
 *
 * На выходе `data/frames-<запись>-<от>-<до>/`: `frame-<секунда>.jpg` и
 * `index.json` — `[{ atSeconds, file }]`. Каталог `data` в `.gitignore`: на
 * кадрах лица и ники зрителей, репозиторий публичный.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectFrames, createFrameIo } from "../../../../src/pipeline/frames.ts";
import { readMediaInfo } from "../../../../src/pipeline/media.ts";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`нужен --${name}`);
  return value;
}

const vod = arg("vod");
const fromSeconds = Number(arg("from"));
const requestedTo = Number(arg("to"));
if (!Number.isInteger(fromSeconds) || !Number.isInteger(requestedTo)) throw new Error("--from и --to — целые секунды");

const info = await readMediaInfo(`https://www.twitch.tv/videos/${vod}`);
const toSeconds = Math.min(requestedTo, info.durationSeconds);
if (info.frameSource === undefined) throw new Error("у записи нет видеодорожки с плейлистом HLS");
console.log(`источник: ${info.frameSource.height}p, отрезок ${fromSeconds}–${toSeconds} с`);

const label = `${vod}-${fromSeconds}-${requestedTo}`;
const outDir = path.resolve(import.meta.dirname, "..", "data", `frames-${label}`);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const io = createFrameIo({
  upload: async (atSeconds, bytes) => {
    const file = `frame-${String(atSeconds).padStart(6, "0")}.jpg`;
    await writeFile(path.join(outDir, file), bytes);
    return file;
  },
  sign: async (file) => file,
});

const { frames, planned } = await collectFrames({
  source: info.frameSource,
  range: { startSeconds: fromSeconds, endSeconds: toSeconds },
  io,
  log: (message) => console.error(message),
});

await writeFile(
  path.join(outDir, "index.json"),
  `${JSON.stringify(frames.map((frame) => ({ atSeconds: frame.atSeconds, file: frame.url })), null, 2)}\n`,
);
console.log(`кадров: ${frames.length} из ${planned} → data/frames-${label}/`);
