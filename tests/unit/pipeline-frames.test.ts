import { test, expect, describe } from "vitest";
import {
  collectFrames,
  isJpeg,
  parsePlaylist,
  segmentAt,
  type Bytes,
  type FrameIo,
} from "../../src/pipeline/frames.ts";
import { pickFrameSource, type RawFormat } from "../../src/pipeline/media.ts";
import { FRAME_URL_TTL_SECONDS, Publisher, frameKey } from "../../src/pipeline/publish.ts";
import { FRAMES_PREFIX } from "../../src/shared/frames.ts";

/**
 * Форматы записи `2878430068` как их отдал `yt-dlp --dump-json`: оставлены поля,
 * по которым выбирается источник кадров, адреса заменены заглушками. Лучшие
 * форматы стоят в конце списка — так их и перечисляет `yt-dlp`.
 */
const REAL_FORMATS: RawFormat[] = [
  { format_id: "sb1", protocol: "mhtml", height: 90, vcodec: "none", url: "https://example.test/sb1/storyboard.mhtml" },
  { format_id: "sb0", protocol: "mhtml", height: 124, vcodec: "none", url: "https://example.test/sb0/storyboard.mhtml" },
  { format_id: "Audio_Only", protocol: "m3u8_native", height: null, vcodec: "none", url: "https://example.test/Audio_Only/index.m3u8" },
  { format_id: "160p", protocol: "m3u8_native", height: 160, vcodec: "avc1.4D400C", url: "https://example.test/160p/index.m3u8" },
  { format_id: "360p", protocol: "m3u8_native", height: 360, vcodec: "avc1.4D401E", url: "https://example.test/360p/index.m3u8" },
  { format_id: "480p", protocol: "m3u8_native", height: 480, vcodec: "avc1.4D401F", url: "https://example.test/480p/index.m3u8" },
  { format_id: "720p60", protocol: "m3u8_native", height: 720, vcodec: "avc1.4D4020", url: "https://example.test/720p60/index.m3u8" },
  { format_id: "1080p60", protocol: "m3u8_native", height: 1080, vcodec: "avc1.64002A", url: "https://example.test/1080p60/index.m3u8" },
];

const only = (...ids: string[]): RawFormat[] => REAL_FORMATS.filter((format) => ids.includes(format.format_id ?? ""));

describe("источник кадров из форматов записи", () => {
  test("из 720p60 и 1080p60 берётся 720p60: выше модели не нужно", () => {
    expect(pickFrameSource(REAL_FORMATS)).toEqual({
      playlistUrl: "https://example.test/720p60/index.m3u8",
      height: 720,
    });
  });

  test("без 720p берётся наибольшая из тех, что не выше", () => {
    expect(pickFrameSource(only("160p", "1080p60"))?.height).toBe(160);
    expect(pickFrameSource(only("360p", "480p", "1080p60"))?.height).toBe(480);
  });

  test("если остались только форматы выше 720 — наименьший из них", () => {
    const formats: RawFormat[] = [
      ...only("1080p60"),
      { format_id: "1440p60", protocol: "m3u8_native", height: 1440, vcodec: "avc1.640033", url: "https://example.test/1440p60/index.m3u8" },
    ];

    expect(pickFrameSource(formats)).toEqual({ playlistUrl: "https://example.test/1080p60/index.m3u8", height: 1080 });
  });

  test("при равной высоте берётся тот, что в списке позже", () => {
    const formats: RawFormat[] = [
      { format_id: "720p", protocol: "m3u8_native", height: 720, vcodec: "avc1.4D401F", url: "https://example.test/720p/index.m3u8" },
      ...only("720p60"),
    ];

    expect(pickFrameSource(formats)?.playlistUrl).toBe("https://example.test/720p60/index.m3u8");
  });

  test("только звук и раскадровка — источника нет", () => {
    expect(pickFrameSource(only("sb1", "sb0", "Audio_Only"))).toBeUndefined();
    expect(pickFrameSource([])).toBeUndefined();
  });

  test("формат без адреса, без высоты или без видео не годится", () => {
    const broken: RawFormat[] = [
      { format_id: "a", protocol: "m3u8_native", height: 720, vcodec: "avc1", url: "" },
      { format_id: "b", protocol: "m3u8_native", height: null, vcodec: "avc1", url: "https://example.test/b.m3u8" },
      { format_id: "c", protocol: "m3u8_native", height: 720, vcodec: "none", url: "https://example.test/c.m3u8" },
      { format_id: "d", protocol: "https", height: 720, vcodec: "avc1", url: "https://example.test/d.mp4" },
    ];

    expect(pickFrameSource(broken)).toBeUndefined();
  });
});

/** Плейлист в том виде, в каком его отдаёт площадка: относительные имена, есть заглушённые сегменты. */
const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:10",
  "#EXT-X-PLAYLIST-TYPE:EVENT",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-TWITCH-TOTAL-SECS:39.251",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-19T15:19:32.826Z",
  "#EXTINF:10.000,",
  "0.ts",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-19T15:19:42.826Z",
  "#EXTINF:10.000,",
  "1.ts",
  "#EXTINF:10.000,",
  "2-muted.ts",
  "#EXTINF:9.251,",
  "3.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const PLAYLIST_URL = "https://example.test/v1/720p60/index-dvr.m3u8";

describe("плейлист", () => {
  test("начало сегмента — сумма длительностей предыдущих, имена берутся как есть", () => {
    const segments = parsePlaylist(PLAYLIST, PLAYLIST_URL);

    expect(segments.map((segment) => segment.startSeconds)).toEqual([0, 10, 20, 30]);
    expect(segments.map((segment) => segment.durationSeconds)).toEqual([10, 10, 10, 9.251]);
    // Имя нестандартного вида не строится по номеру, а берётся из плейлиста.
    expect(segments[2]?.url).toBe("https://example.test/v1/720p60/2-muted.ts");
  });

  test("абсолютный адрес остаётся как есть, окончания строк Windows не мешают", () => {
    const segments = parsePlaylist("#EXTM3U\r\n#EXTINF:10.000,\r\nhttps://cdn.example.test/x/0.ts\r\n", PLAYLIST_URL);

    expect(segments).toEqual([{ url: "https://cdn.example.test/x/0.ts", startSeconds: 0, durationSeconds: 10 }]);
  });

  test("сегмент без длительности — ошибка: время следующих поехало бы", () => {
    expect(() => parsePlaylist("#EXTINF:,\n0.ts", PLAYLIST_URL)).toThrow();
    expect(() => parsePlaylist("#EXTINF:0.000,\n0.ts", PLAYLIST_URL)).toThrow();
  });

  test("пустой плейлист — пустой список", () => {
    expect(parsePlaylist("", PLAYLIST_URL)).toEqual([]);
    expect(parsePlaylist("#EXTM3U\n#EXT-X-ENDLIST", PLAYLIST_URL)).toEqual([]);
  });

  test("сегмент по секунде: начало включается, конец исключается", () => {
    const segments = parsePlaylist(PLAYLIST, PLAYLIST_URL);

    expect(segmentAt(segments, 0)?.url).toMatch(/0\.ts$/);
    expect(segmentAt(segments, 9.999)?.url).toMatch(/0\.ts$/);
    expect(segmentAt(segments, 10)?.url).toMatch(/1\.ts$/);
    expect(segmentAt(segments, 39.25)?.url).toMatch(/3\.ts$/);
    // Конец плейлиста и всё за ним — сегмента нет.
    expect(segmentAt(segments, 39.251)).toBeUndefined();
    expect(segmentAt(segments, 5000)).toBeUndefined();
    expect(segmentAt(segments, -1)).toBeUndefined();
  });

  test("JPEG узнаётся по маркеру начала", () => {
    expect(isJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(isJpeg(new Uint8Array())).toBe(false);
    expect(isJpeg(Uint8Array.of(0xff))).toBe(false);
    expect(isJpeg(new TextEncoder().encode("<html>"))).toBe(false);
  });
});

/** Сегменты по десять секунд подряд на 1800 секунд, как у обычной записи. */
const longPlaylist = (): string =>
  ["#EXTM3U", ...Array.from({ length: 180 }, (_, index) => `#EXTINF:10.000,\n${index}.ts`), "#EXT-X-ENDLIST"].join("\n");

const jpeg = (marker: string): Bytes => Uint8Array.of(0xff, 0xd8, ...new TextEncoder().encode(marker));

interface FakeIo {
  io: FrameIo;
  uploaded: number[];
  fetched: string[];
  maxInFlight: () => number;
}

/** Подставные вызовы: ни сети, ни ffmpeg, ни R2. Каждый сбой включается отдельно. */
function fakeIo(
  options: {
    playlist?: string | Error;
    badSegment?: string;
    notJpegFor?: string;
    uploadFails?: number;
    extractFails?: string;
  } = {},
): FakeIo {
  const uploaded: number[] = [];
  const fetched: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const io: FrameIo = {
    fetchText: async () => {
      if (options.playlist instanceof Error) throw options.playlist;
      return options.playlist ?? longPlaylist();
    },
    fetchBytes: async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      fetched.push(url);
      if (options.badSegment !== undefined && url.endsWith(options.badSegment)) {
        throw new Error(`площадка ответила 404 на ${url}`);
      }
      return new TextEncoder().encode(url);
    },
    extractFrame: async (segment) => {
      const url = new TextDecoder().decode(segment);
      if (options.extractFails !== undefined && url.endsWith(options.extractFails)) {
        throw new Error(`ffmpeg: Invalid data found when processing input ${url}`);
      }
      if (options.notJpegFor !== undefined && url.endsWith(options.notJpegFor)) return new TextEncoder().encode("пусто");
      return jpeg(url);
    },
    upload: async (atSeconds) => {
      if (options.uploadFails === atSeconds) throw new Error("R2 отклонил кадр: 500");
      uploaded.push(atSeconds);
      return `frames/test/frame-${String(atSeconds).padStart(6, "0")}.jpg`;
    },
    sign: async (key) => `https://signed.example.test/twitch-audio/${key}?X-Amz-Signature=secret`,
  };
  return { io, uploaded, fetched, maxInFlight: () => peak };
}

const SOURCE = { playlistUrl: PLAYLIST_URL, height: 720 };
const RANGE = { startSeconds: 0, endSeconds: 1800 };

describe("добыча кадров", () => {
  test("все кадры удались: по возрастанию, подпись — начало сегмента", async () => {
    const { io, uploaded } = fakeIo();
    const logged: string[] = [];

    const { frames, planned } = await collectFrames({ source: SOURCE, range: RANGE, io, log: (m) => logged.push(m) });

    // 1800 с → десять окон по 180 с; середина окна 90 → сегмент с 90-й секунды.
    expect(planned).toBe(10);
    expect(frames).toHaveLength(10);
    expect(frames.map((frame) => frame.atSeconds)).toEqual([90, 270, 450, 630, 810, 990, 1170, 1350, 1530, 1710]);
    expect(uploaded).toEqual(frames.map((frame) => frame.atSeconds));
    expect(frames[0]?.url).toBe(
      "https://signed.example.test/twitch-audio/frames/test/frame-000090.jpg?X-Amz-Signature=secret",
    );
    expect(logged).toEqual([]);
  });

  test("вторая часть эфира: кадры внутри отрезка и с абсолютным временем", async () => {
    const playlist = ["#EXTM3U", ...Array.from({ length: 400 }, (_, index) => `#EXTINF:10.000,\n${index}.ts`)].join("\n");
    const { io } = fakeIo({ playlist });

    const { frames } = await collectFrames({
      source: SOURCE,
      range: { startSeconds: 1800, endSeconds: 3600 },
      io,
      log: () => undefined,
    });

    expect(frames[0]?.atSeconds).toBe(1890);
    expect(frames.every((frame) => frame.atSeconds >= 1800 && frame.atSeconds < 3600)).toBe(true);
  });

  test("сегмент не скачался — пропущен этот кадр, остальные собраны", async () => {
    const { io } = fakeIo({ badSegment: "/27.ts" });
    const logged: string[] = [];

    const { frames, planned } = await collectFrames({ source: SOURCE, range: RANGE, io, log: (m) => logged.push(m) });

    expect(planned).toBe(10);
    expect(frames.map((frame) => frame.atSeconds)).not.toContain(270);
    expect(frames).toHaveLength(9);
    expect(logged).toHaveLength(1);
  });

  test("ffmpeg вернул не JPEG — кадр пропущен", async () => {
    const { io, uploaded } = fakeIo({ notJpegFor: "/45.ts" });

    const { frames } = await collectFrames({ source: SOURCE, range: RANGE, io, log: () => undefined });

    expect(frames).toHaveLength(9);
    // Мусор в хранилище не попадает.
    expect(uploaded).not.toContain(450);
  });

  test("ffmpeg упал — кадр пропущен", async () => {
    const { io } = fakeIo({ extractFails: "/63.ts" });

    const { frames } = await collectFrames({ source: SOURCE, range: RANGE, io, log: () => undefined });

    expect(frames.map((frame) => frame.atSeconds)).not.toContain(630);
    expect(frames).toHaveLength(9);
  });

  test("загрузка в хранилище не удалась — кадр пропущен", async () => {
    const { io } = fakeIo({ uploadFails: 810 });

    const { frames } = await collectFrames({ source: SOURCE, range: RANGE, io, log: () => undefined });

    expect(frames.map((frame) => frame.atSeconds)).not.toContain(810);
    expect(frames).toHaveLength(9);
  });

  test("плейлист не открылся — пустой список без исключения", async () => {
    const { io } = fakeIo({ playlist: new Error("площадка ответила 403") });
    const logged: string[] = [];

    const result = await collectFrames({ source: SOURCE, range: RANGE, io, log: (m) => logged.push(m) });

    expect(result).toEqual({ frames: [], planned: 10 });
    expect(logged).toHaveLength(1);
  });

  test("плейлист короче отрезка — кадры там, где есть сегменты", async () => {
    const short = ["#EXTM3U", ...Array.from({ length: 50 }, (_, index) => `#EXTINF:10.000,\n${index}.ts`)].join("\n");
    const { io } = fakeIo({ playlist: short });

    const { frames, planned } = await collectFrames({ source: SOURCE, range: RANGE, io, log: () => undefined });

    // Плейлист кончается на 500-й секунде: кадры 90, 270 и 450.
    expect(planned).toBe(10);
    expect(frames.map((frame) => frame.atSeconds)).toEqual([90, 270, 450]);
  });

  test("два окна на один сегмент дают один кадр, а не две записи с одной секундой", async () => {
    const huge = "#EXTM3U\n#EXTINF:1800.000,\nwhole.ts";
    const { io, uploaded } = fakeIo({ playlist: huge });

    const { frames } = await collectFrames({ source: SOURCE, range: RANGE, io, log: () => undefined });

    expect(frames.map((frame) => frame.atSeconds)).toEqual([0]);
    expect(uploaded).toEqual([0]);
  });

  test("окна обрабатываются по очереди, а не наперегонки", async () => {
    const fake = fakeIo();

    await collectFrames({ source: SOURCE, range: RANGE, io: fake.io, log: () => undefined });

    expect(fake.maxInFlight()).toBe(1);
  });

  test("в журнале нет ни одного адреса — ни из плейлиста, ни из сообщений ошибок", async () => {
    const logged: string[] = [];
    const broken = new Error("fetch https://secret.example.test/v1/index.m3u8?token=abc123 failed");

    await collectFrames({ source: SOURCE, range: RANGE, io: fakeIo({ playlist: broken }).io, log: (m) => logged.push(m) });
    await collectFrames({ source: SOURCE, range: RANGE, io: fakeIo({ badSegment: "/27.ts" }).io, log: (m) => logged.push(m) });
    await collectFrames({ source: SOURCE, range: RANGE, io: fakeIo({ extractFails: "/63.ts" }).io, log: (m) => logged.push(m) });

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toMatch(/https?:\/\//);
      expect(line).not.toContain("abc123");
    }
  });
});

describe("ссылка на кадр", () => {
  const publisher = new Publisher({
    accountId: "acct123",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret-example",
    bucket: "twitch-audio",
  });

  test("подписана на шесть часов и указывает на объект кадра в R2", async () => {
    const url = new URL(await publisher.signFrameUrl("frames/2878430068/frame-000090.jpg"));

    expect(FRAME_URL_TTL_SECONDS).toBe(6 * 3600);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/twitch-audio/frames/2878430068/frame-000090.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("21600");
    // Подпись в адресе, а не в заголовках: модель скачивает по голой ссылке.
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("AKIAEXAMPLE");
  });
});

describe("ключ кадра в хранилище", () => {
  test("ключ определён моментом: тот же кадр — тот же объект, перезапись, а не копия", () => {
    expect(frameKey("2878430068", 1800)).toBe("frames/2878430068/frame-001800.jpg");
    expect(frameKey("2878430068", 1800)).toBe(frameKey("2878430068", 1800));
    // Секунды дополняются нулями до шести знаков: ключи сортируются как время.
    expect(frameKey("2878430068", 90)).toBe("frames/2878430068/frame-000090.jpg");
  });

  test("ключ лежит под общим префиксом, по которому Worker убирает кадры", () => {
    // Раскладку задаёт бокс, а убирает Worker: если они разойдутся, кадры
    // останутся в хранилище с лицами и никами. Префикс общий (`FRAMES_PREFIX`),
    // а что уборка Worker им пользуется, проверяет `tests/worker/temporary.test.ts`.
    expect(FRAMES_PREFIX).toBe("frames/");
    expect(frameKey("2878430068", 1800).startsWith(`${FRAMES_PREFIX}2878430068/`)).toBe(true);
  });

  test("уборка части не задевает соседнюю запись, и наоборот", () => {
    // Уборка идёт по `<префикс><идентификатор>/`: слэш отделяет `frames/123/` от `frames/123-p2/`.
    const whole = frameKey("2878430068", 1800);
    const part = frameKey("2878430068-p2", 1800);
    const underFrames = (id: string) => (key: string) => key.startsWith(`frames/${id}/`);

    expect(underFrames("2878430068")(part)).toBe(false);
    expect(underFrames("2878430068-p2")(whole)).toBe(false);
    expect(underFrames("2878430068")(whole)).toBe(true);
    expect(underFrames("2878430068-p2")(part)).toBe(true);
  });

  test("ключ кадра не совпадает с ключами звука и расшифровки той же записи", () => {
    const key = frameKey("2878430068", 0);

    expect(key.startsWith("audio/")).toBe(false);
    expect(key.startsWith("transcript/")).toBe(false);
  });
});
