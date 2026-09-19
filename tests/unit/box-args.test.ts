import { test, expect, describe, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRunner, buildIngestCommand } from "../../src/shared/box.ts";
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

/**
 * Команда запуска прогона проверяется настоящей оболочкой на временном
 * каталоге: бокса рядом нет, а ошибку в команде иначе видно только по тому,
 * что разбор не начался, — и нигде не видно почему.
 */
describe("команда запуска прогона", () => {
  const homes: string[] = [];

  afterAll(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  /** Каталог, изображающий рабочий каталог бокса. */
  function boxHome(files: { pipeline?: boolean; env?: boolean } = {}): string {
    const home = mkdtempSync(join(tmpdir(), "box-home-"));
    homes.push(home);
    if (files.pipeline !== false) writeFileSync(join(home, "pipeline.mjs"), "process.exit(0)\n");
    if (files.env !== false) writeFileSync(join(home, ".env.pipeline"), "X=1\n");
    return home;
  }

  function run(home: string): { code: number | null; stderr: string } {
    const command = buildIngestCommand({
      vodId: "2345678901",
      url: "https://www.twitch.tv/videos/2345678901",
      callbackUrl: "https://example.workers.dev/api/internal/ingest-ready",
      attempt: "t1",
      home,
    });
    // Оболочка та же, что у бокса, и без «bash» на конце: команда обязана быть
    // обычным sh, иначе на боксе она может просто не разобраться.
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    return { code: result.status, stderr: result.stderr };
  }

  test("без файла прогона запуск отвергается, а не проходит молча", () => {
    // Откреплённый запуск возвращает ноль всегда — даже когда команды не
    // существует вовсе, — поэтому без проверки впереди пропажа файла
    // оставалась бы незамеченной, а Worker ждал бы обратного вызова.
    const result = run(boxHome({ pipeline: false }));

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("нет файла прогона");
  });

  test("без файла секретов запуск отвергается", () => {
    const result = run(boxHome({ env: false }));

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("нет файла секретов");
  });

  test("когда оба файла на месте, запуск проходит", () => {
    expect(run(boxHome()).code).toBe(0);
  });

  test("журнал захода и значения записи попадают в команду", () => {
    const command = buildIngestCommand({
      vodId: "2345678901",
      url: "https://www.twitch.tv/videos/2345678901",
      callbackUrl: "https://example.workers.dev/api/internal/ingest-ready",
      attempt: "t1",
      home: "/workspace/home",
    });

    expect(command).toContain("ingest-2345678901-t1.log");
    expect(command).toContain("--vod '2345678901'");
    expect(command).toContain("--url 'https://www.twitch.tv/videos/2345678901'");
    expect(command).toContain("--callback 'https://example.workers.dev/api/internal/ingest-ready'");
  });
});
