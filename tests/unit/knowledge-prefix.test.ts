import { test, expect, describe, afterEach } from "vitest";
import { Knowledge, chunkId } from "../../src/shared/knowledge.ts";
import { AppError } from "../../src/shared/errors.ts";

/**
 * Удаление и переименование идут по префиксу идентификатора. Префикс `123:`
 * не задевает `123-p2:` — но только пока идентификатор целый: пустая строка
 * или `123-p2/..` снесли бы чужое. Проверяется на подменённой сети.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function stubVector(answers: (url: string) => unknown): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ result: answers(url) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return sent;
}

const knowledge = () => new Knowledge({ url: "https://example.upstash.io", token: "token" });
const emptyPage = { nextCursor: "", vectors: [] };

describe("префикс уборки знаний", () => {
  test("запись и её часть — разные префиксы, друг друга не задевают", async () => {
    const sent = stubVector(() => ({ deleted: 1 }));

    await knowledge().removeStream("2878430068");
    await knowledge().removeStream("2878430068-p2");

    expect(sent.map((item) => item.body["prefix"])).toEqual(["2878430068:", "2878430068-p2:"]);
    // Префикс целой записи не начало префикса части: `2878430068:` ≠ `2878430068-p2:`.
    expect("2878430068-p2:".startsWith("2878430068:")).toBe(false);
  });

  test("обход при переименовании и уборке идёт по префиксу своей записи", async () => {
    const sent = stubVector(() => emptyPage);

    await knowledge().renameStream("2878430068-p2", "Имя");
    await knowledge().removeExcept("2878430068-p2", new Set());

    expect(sent.map((item) => item.body["prefix"])).toEqual(["2878430068-p2:", "2878430068-p2:"]);
  });

  test.each(["", ":", "2878430068:", "2878430068-p2/..", "../1", "1-p0", "abc", "1*"])(
    "идентификатор не по образцу отвергается до запроса к сети: %j",
    async (bad) => {
      const sent = stubVector(() => ({ deleted: 1 }));
      const target = knowledge();

      for (const call of [
        () => target.removeStream(bad),
        () => target.removeExcept(bad, new Set()),
        () => target.renameStream(bad, "Имя"),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(AppError);
        await expect(call()).rejects.toMatchObject({ code: "invalid_input" });
      }
      expect(sent).toHaveLength(0);
    },
  );
});

/**
 * Повторный разбор заменяет знания записи: новые куски пишутся первыми, а
 * прежние, которых среди них нет, вычищаются шагом «убрать куски прошлого
 * разбора» (`removeExcept`). Кадры этого не меняют — они в куски не попадают, —
 * но замена должна работать и у документа, составленного с кадрами.
 */
describe("замена знаний прошлого разбора", () => {
  const id = (section: number, chunk = 0) => chunkId("2878430068", section, chunk);

  test("уходят только куски, которых нет среди свежих, — по всем страницам обхода", async () => {
    const pages = [
      { nextCursor: "100", vectors: [{ id: id(0) }, { id: id(1) }] },
      { nextCursor: "", vectors: [{ id: id(2) }, { id: id(3) }] },
    ];
    const sent = stubVector((url) => (url.endsWith("/range") ? pages.shift() : { deleted: 2 }));

    const removed = await knowledge().removeExcept("2878430068", new Set([id(0), id(2)]));

    expect(removed).toBe(2);
    const deletions = sent.filter((item) => item.url.endsWith("/delete"));
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.body).toEqual({ ids: [id(1), id(3)] });
  });

  test("удаление идёт после обхода целиком, а не посреди него", async () => {
    // Удаление по ходу сдвигало бы страницы под обходом и пропускало куски.
    const pages = [
      { nextCursor: "100", vectors: [{ id: id(1) }] },
      { nextCursor: "", vectors: [{ id: id(2) }] },
    ];
    const sent = stubVector((url) => (url.endsWith("/range") ? pages.shift() : { deleted: 2 }));

    await knowledge().removeExcept("2878430068", new Set());

    expect(sent.map((item) => item.url.split("/").pop())).toEqual(["range", "range", "delete"]);
  });

  test("нечего убирать — удаления нет, и счёт нулевой", async () => {
    const sent = stubVector(() => ({ nextCursor: "", vectors: [{ id: id(0) }, { id: id(1) }] }));

    const removed = await knowledge().removeExcept("2878430068", new Set([id(0), id(1)]));

    expect(removed).toBe(0);
    expect(sent.some((item) => item.url.endsWith("/delete"))).toBe(false);
  });

  test("обход идёт по префиксу своей записи и берёт страницами по сто", async () => {
    const sent = stubVector(() => emptyPage);

    await knowledge().removeExcept("2878430068", new Set());

    expect(sent[0]?.body).toMatchObject({ prefix: "2878430068:", limit: 100 });
  });
});
