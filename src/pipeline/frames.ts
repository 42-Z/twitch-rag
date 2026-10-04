/**
 * Кадры эфира в боксе: источник → плейлист → сегмент → кадр → R2 → ссылка.
 *
 * Кадр берётся из сегмента плейлиста HLS, а не отдельным запуском `yt-dlp`:
 * запуск стоит 0,870 с процессорного времени бокса, кадр из сегмента — 0,281 с
 * целиком (замер: `specs/007-stream-frames/baseline.md` §4). Первый пакет
 * сегмента — ключевой кадр, поэтому `ffmpeg -frames:v 1` отдаёт готовую картинку
 * без разбора предыдущих.
 *
 * Адрес сегмента берётся из плейлиста как есть: раскладку адресов площадка не
 * документирует, и угадывать её по номеру незачем. Формат плейлиста — HLS
 * ([RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216)).
 *
 * Кадры — добавка к звуку, а не условие разбора: неудача одного кадра
 * пропускает его, неудача плейлиста даёт пустой список, и ни то ни другое не
 * бросает исключения. В журнал идут числа и причины без адресов: ссылка на
 * кадр — носитель доступа.
 */

import { spawn } from "node:child_process";
import { redactUrls } from "../shared/errors.ts";
import { frameWindows, type Frame } from "../shared/frames.ts";
import type { TimeRange } from "../shared/categories.ts";
import type { FrameSource } from "./media.ts";
import { withRetries } from "./publish.ts";

/**
 * Байты сегмента и кадра. `ArrayBuffer`, а не `ArrayBufferLike`: тело запроса
 * в типах `fetch` не принимает общую память.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Один сегмент плейлиста: адрес и где он лежит на оси эфира. */
export interface Segment {
  url: string;
  startSeconds: number;
  durationSeconds: number;
}

/** Модель принимает до 1280 px, а больше ей незачем: тяжелее, а читается так же. */
const FRAME_MAX_WIDTH = 1280;
const PLAYLIST_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 60_000;
/** Кадр из сегмента снимается за доли секунды: зависший `ffmpeg` не должен держать сигнал готовности. */
const FFMPEG_TIMEOUT_MS = 30_000;
/**
 * Сколько кадров подряд могут не удаться, прежде чем добыча остановится. Каждый
 * неудавшийся кадр — четыре попытки с паузами, и если площадка закрыла сегменты
 * или молчит, 115 окон задержали бы сигнал готовности, а с ним и распознавание
 * звука, на минуты или часы. Одиночный сбой кадр лишь пропускает (FR-016).
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Сегменты плейлиста. Начало сегмента — сумма длительностей предыдущих
 * (`#EXTINF`); относительный адрес разрешается от адреса плейлиста.
 */
export function parsePlaylist(text: string, playlistUrl: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let pendingDuration: number | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#EXT-X-BYTERANGE") || line.startsWith("#EXT-X-MAP")) {
      // RFC 8216, 4.3.2.2 и 4.3.2.5: сегмент — часть общего файла либо без заголовка инициализации не
      // декодируется. Целый файл на каждый кадр не скачать, а без заголовка `ffmpeg` кадра не отдаст: лучше без кадров.
      throw new Error("плейлист с #EXT-X-BYTERANGE или #EXT-X-MAP не поддерживается");
    }
    if (line.startsWith("#EXTINF:")) {
      // `#EXTINF:<длительность>,[<название>]`: parseFloat останавливается на запятой.
      const duration = Number.parseFloat(line.slice("#EXTINF:".length));
      if (!Number.isFinite(duration) || duration <= 0) {
        // Без длительности время всех следующих сегментов поехало бы — лучше без кадров.
        throw new Error("в плейлисте сегмент без длительности");
      }
      pendingDuration = duration;
      continue;
    }
    if (line.startsWith("#") || pendingDuration === undefined) continue;

    segments.push({
      url: new URL(line, playlistUrl).href,
      startSeconds: cursor,
      durationSeconds: pendingDuration,
    });
    cursor += pendingDuration;
    pendingDuration = undefined;
  }
  return segments;
}

/** Сегмент, в который попадает секунда: начало включается, конец нет. */
export function segmentAt(segments: readonly Segment[], seconds: number): Segment | undefined {
  return segments.find((segment) => seconds >= segment.startSeconds && seconds < segment.startSeconds + segment.durationSeconds);
}

/** JPEG начинается с маркера `FF D8`: пустой или чужой ответ кадром не считается. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * Первый кадр сегмента: сегмент идёт в `ffmpeg` через stdin, картинка — из stdout.
 *
 * `ffmpeg` снимает один кадр и выходит, не дочитав сегмент, поэтому запись в
 * закрытую трубу — штатный конец, а не отказ: ошибка stdin игнорируется, а
 * исход определяют код выхода и непустой вывод. Фильтр записан так, как его
 * читает `ffmpeg` (кавычки — часть его синтаксиса, запятая в `min()` иначе
 * разделила бы фильтры): оболочки здесь нет.
 */
export function extractFrame(segment: Bytes): Promise<Bytes> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-frames:v", "1",
        "-q:v", "4",
        "-vf", `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
        "-f", "mjpeg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: FFMPEG_TIMEOUT_MS },
    );

    const output: Buffer[] = [];
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(errors.trim() || `ffmpeg завершился с кодом ${code}`));
    });
    child.stdin.end(segment);
  });
}

/**
 * Внешние вызовы добычи. Принимаются параметром, чтобы добыча проверялась без
 * сети и без `ffmpeg`.
 */
export interface FrameIo {
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string): Promise<Bytes>;
  extractFrame(segment: Bytes): Promise<Bytes>;
  /** Кладёт кадр в хранилище и возвращает ключ объекта. */
  upload(atSeconds: number, bytes: Bytes): Promise<string>;
  /** Ссылка на чтение объекта по ключу. */
  sign(key: string): Promise<string>;
}

async function download(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`площадка ответила ${response.status}`);
  return response;
}

/**
 * Настоящие вызовы: плейлист и сегменты ходят с таймаутом и до четырёх попыток,
 * как звук. Зависшая загрузка без таймаута оставила бы запись в «разбирается»:
 * сигнал готовности ушёл бы только после неё.
 */
export function createFrameIo(storage: Pick<FrameIo, "upload" | "sign">): FrameIo {
  return {
    fetchText: (url) => withRetries(async () => (await download(url, PLAYLIST_TIMEOUT_MS)).text()),
    fetchBytes: (url) =>
      withRetries(async () => new Uint8Array(await (await download(url, SEGMENT_TIMEOUT_MS)).arrayBuffer())),
    extractFrame,
    upload: storage.upload,
    sign: storage.sign,
  };
}

/** Текст ошибки для журнала: адреса в нём — носители доступа, их убирает эта функция, а не надежда на авторов ошибок. */
export function describeError(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}

export interface CollectedFrames {
  /** Удавшиеся кадры по возрастанию `atSeconds`. */
  frames: Frame[];
  /** Сколько кадров задумано (число окон отрезка). */
  planned: number;
}

/**
 * Кадры отрезка: по окну на каждый, по очереди. Процессорное время параллельность
 * не уменьшает, а лишняя сложность не окупается.
 *
 * `atSeconds` — начало сегмента, а не расчётный момент окна: подпись должна быть
 * честной. Сегмент начинается не раньше чем за его длину до момента, а момент —
 * не ближе 44 с к началу окна, так что кадр остаётся в своём окне.
 */
export async function collectFrames(options: {
  source: FrameSource;
  range: TimeRange;
  io: FrameIo;
  log: (message: string) => void;
}): Promise<CollectedFrames> {
  const { source, range, io, log } = options;
  const windows = frameWindows(range);

  let segments: Segment[];
  try {
    segments = parsePlaylist(await io.fetchText(source.playlistUrl), source.playlistUrl);
  } catch (error) {
    log(`плейлист кадров не открылся: ${describeError(error)}`);
    return { frames: [], planned: windows.length };
  }

  const frames: Frame[] = [];
  const taken = new Set<number>();
  let failedInRow = 0;
  for (const window of windows) {
    const segment = segmentAt(segments, window.momentSeconds);
    if (segment === undefined) {
      log(`кадр на ${window.momentSeconds} с пропущен: в плейлисте нет сегмента на этот момент`);
      continue;
    }
    const atSeconds = Math.floor(segment.startSeconds);
    // Два окна на один сегмент дали бы один ключ и две записи с одной секундой.
    if (taken.has(atSeconds)) {
      log(`кадр на ${window.momentSeconds} с пропущен: сегмент уже взят другим окном`);
      continue;
    }

    try {
      const bytes = await io.extractFrame(await io.fetchBytes(segment.url));
      if (!isJpeg(bytes)) throw new Error("ffmpeg не вернул JPEG");

      const url = await io.sign(await io.upload(atSeconds, bytes));
      taken.add(atSeconds);
      frames.push({ atSeconds, url });
      failedInRow = 0;
    } catch (error) {
      log(`кадр на ${window.momentSeconds} с пропущен: ${describeError(error)}`);
      failedInRow += 1;
      if (failedInRow >= MAX_CONSECUTIVE_FAILURES) {
        log(`добыча кадров остановлена: ${failedInRow} кадра подряд не удались`);
        break;
      }
    }
  }
  return { frames, planned: windows.length };
}
