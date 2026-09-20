import { test, expect, describe, afterEach } from "vitest";
import { Knowledge } from "../../src/shared/knowledge.ts";
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
