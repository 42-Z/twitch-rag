import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { removeTemporary } from "../../src/worker/temporary.ts";

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
    ]);
  });

  test("часть убирается, не задевая целую запись", async () => {
    await fill();

    await removeTemporary(env.AUDIO, "2878430068-p2");

    expect(await present()).toEqual(["audio/2878430068/chunk-0000.m4a", "transcript/2878430068/full.txt"]);
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
});
