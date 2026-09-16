import { test, expect, describe } from "bun:test";
import { BoxRunner } from "../../src/shared/box.ts";
import { AppError } from "../../src/shared/errors.ts";

/**
 * Значения уходят в командную оболочку бокса, а идентификатор записи ещё и
 * становится частью пути к журналу. Проверка обязана отсекать это до сети,
 * поэтому тесты не поднимают ни одного соединения.
 */
const runner = new BoxRunner({ boxId: "box_test", apiKey: "key_test" });

const good = {
  vodId: "2345678901",
  url: "https://www.twitch.tv/videos/2345678901",
  callbackUrl: "https://example.workers.dev/api/internal/ingest-ready",
};

async function reject(input: Partial<typeof good>): Promise<AppError> {
  try {
    await runner.startIngest({ ...good, ...input });
  } catch (error) {
    return error as AppError;
  }
  throw new Error("значение принято, хотя должно было быть отвергнуто");
}

describe("проверка аргументов запуска разбора", () => {
  test("выход из каталога журнала отвергается", async () => {
    const error = await reject({ vodId: "../../etc/passwd" });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("invalid_input");
  });

  test("идентификатор со слэшем или точкой отвергается", async () => {
    expect((await reject({ vodId: "234/567" })).code).toBe("invalid_input");
    expect((await reject({ vodId: "234.567" })).code).toBe("invalid_input");
  });

  test("буквы и дефис в идентификаторе отвергаются", async () => {
    expect((await reject({ vodId: "-rf" })).code).toBe("invalid_input");
    expect((await reject({ vodId: "abc" })).code).toBe("invalid_input");
  });

  test("кавычка в адресе отвергается — иначе она вырвалась бы из команды", async () => {
    expect((await reject({ url: "https://x/'; rm -rf /; echo '" })).code).toBe("invalid_input");
  });

  test("адрес не по https отвергается", async () => {
    expect((await reject({ callbackUrl: "http://example.com/hook" })).code).toBe("invalid_input");
    expect((await reject({ callbackUrl: "file:///etc/passwd" })).code).toBe("invalid_input");
  });

  test("пустые значения отвергаются", async () => {
    expect((await reject({ vodId: "" })).code).toBe("invalid_input");
    expect((await reject({ url: "" })).code).toBe("invalid_input");
  });
});
