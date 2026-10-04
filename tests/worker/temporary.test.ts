import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FRAMES_PREFIX } from "../../src/shared/frames.ts";
import { TEMPORARY_PREFIXES, removeFrames, removeTemporary } from "../../src/worker/temporary.ts";

/**
 * Уборка временного по префиксам — на настоящей привязке хранилища аудио.
 * Части одного эфира разбираются порознь, и уборка одной не должна
 * задевать другую.
 */
const KEYS = [
  "audio/2878430068/chunk-0000.m4a",
  "audio/2878430068-p2/chunk-0000.m4a",
  "transcript/2878430068/full.txt",
  "transcript/2878430068-p2/full.txt",
  "frames/2878430068/frame-000090.jpg",
  "frames/2878430068-p2/frame-000090.jpg",
];

async function fill(): Promise<void> {
  for (const key of KEYS) await env.AUDIO.put(key, "данные");
}

async function present(): Promise<string[]> {
  const found: string[] = [];
  for (const key of KEYS) if ((await env.AUDIO.head(key)) !== null) found.push(key);
  return found;
}

describe("уборка временного", () => {
  test("убирает объекты своей записи и не трогает соседнюю часть", async () => {
    await fill();

    await removeTemporary(env.AUDIO, "2878430068");

    expect(await present()).toEqual([
      "audio/2878430068-p2/chunk-0000.m4a",
      "transcript/2878430068-p2/full.txt",
      "frames/2878430068-p2/frame-000090.jpg",
    ]);
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("часть убирается, не задевая целую запись", async () => {
    await fill();

    await removeTemporary(env.AUDIO, "2878430068-p2");

    expect(await present()).toEqual([
      "audio/2878430068/chunk-0000.m4a",
      "transcript/2878430068/full.txt",
      "frames/2878430068/frame-000090.jpg",
    ]);
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("кадры своей записи убираются вместе с остальным временным", async () => {
    await fill();

    await removeTemporary(env.AUDIO, "2878430068");

    expect(await present()).not.toContain("frames/2878430068/frame-000090.jpg");
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("повтор на пустом префиксе безопасен", async () => {
    await removeTemporary(env.AUDIO, "2878430068-p9");
    await removeTemporary(env.AUDIO, "2878430068-p9");
  });

  test("идентификатор не по образцу отвергается до обращения к хранилищу", async () => {
    await fill();

    for (const bad of ["", "abc", "2878430068-p0", "../2878430068"]) {
      await expect(removeTemporary(env.AUDIO, bad)).rejects.toMatchObject({ code: "invalid_input" });
    }

    expect((await present()).length).toBe(KEYS.length);
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("перечень временного включает кадры — по нему же чистит и почасовая уборка", () => {
    // Бокс кладёт кадры под общим `FRAMES_PREFIX`; выпавший из перечня, он
    // оставлял бы их в хранилище до отмены правила (`cleanupStaleAudio` читает тот же перечень).
    expect(FRAMES_PREFIX).toBe("frames/");
    expect(TEMPORARY_PREFIXES).toContain(FRAMES_PREFIX);
  });
});

describe("уборка одних кадров", () => {
  test("убирает только каталог кадров записи: аудио и расшифровка остаются", async () => {
    await fill();

    await removeFrames(env.AUDIO, "2878430068");

    // Сбой разбора: проходы составления без кадров не повторяются, а звук и текст нужны переигровке.
    expect(await present()).toEqual([
      "audio/2878430068/chunk-0000.m4a",
      "audio/2878430068-p2/chunk-0000.m4a",
      "transcript/2878430068/full.txt",
      "transcript/2878430068-p2/full.txt",
      "frames/2878430068-p2/frame-000090.jpg",
    ]);
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("соседняя часть и целая запись не задеты", async () => {
    await fill();

    await removeFrames(env.AUDIO, "2878430068-p2");

    expect(await present()).toContain("frames/2878430068/frame-000090.jpg");
    expect(await present()).not.toContain("frames/2878430068-p2/frame-000090.jpg");
    for (const key of KEYS) await env.AUDIO.delete(key);
  });

  test("повтор на пустом префиксе безопасен", async () => {
    await removeFrames(env.AUDIO, "2878430068-p9");
    await removeFrames(env.AUDIO, "2878430068-p9");
  });

  test("идентификатор не по образцу отвергается до обращения к хранилищу", async () => {
    await fill();

    // Пустая строка дала бы префикс `frames/` и снесла бы кадры всех записей.
    for (const bad of ["", "abc", "2878430068-p0", "../2878430068"]) {
      await expect(removeFrames(env.AUDIO, bad)).rejects.toMatchObject({ code: "invalid_input" });
    }

    expect((await present()).length).toBe(KEYS.length);
    for (const key of KEYS) await env.AUDIO.delete(key);
  });
});
