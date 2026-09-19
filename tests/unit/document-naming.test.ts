import { test, expect, describe } from "bun:test";
import { documentSectionTitles, renameDocumentHeader } from "../../src/shared/documents.ts";
import { nameDocumentsWithoutNames } from "../../src/worker/naming.ts";
import type { Services } from "../../src/worker/env.ts";
import type { StreamRecord } from "../../src/shared/registry.ts";

const DOCUMENT = [
  "# РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка",
  "",
  "**Эфир**: 2026-09-16 · **Длительность**: 3 ч 49 мин",
  "",
  "## Выборы и новые люди [0:00:00 — 0:12:34]",
  "",
  "Текст первого раздела.",
  "",
  "## История с удостоверением [0:12:34 — 0:25:01]",
  "",
  "Текст второго раздела.",
  "",
].join("\n");

describe("разбор готового документа", () => {
  test("заголовки разделов берутся без времени", () => {
    expect(documentSectionTitles(DOCUMENT)).toEqual(["Выборы и новые люди", "История с удостоверением"]);
  });

  test("без разделов заголовков нет", () => {
    expect(documentSectionTitles("# Имя\n\n**Эфир**: 2026-09-16\n")).toEqual([]);
  });

  test("имя в шапке заменяется, остальное остаётся как было", () => {
    const renamed = renameDocumentHeader(DOCUMENT, "Выборы, донаты и удостоверение");

    expect(renamed.split("\n")[0]).toBe("# Выборы, донаты и удостоверение");
    expect(renamed).toContain("Текст второго раздела.");
    expect(renamed).toContain("## История с удостоверением [0:12:34 — 0:25:01]");
  });

  test("документ без шапки не переименовывается молча", () => {
    // Молчание здесь означало бы «имя заменено», которого не случилось.
    expect(() => renameDocumentHeader("просто текст\n", "Имя")).toThrow();
  });
});

interface Captured {
  patched: Array<{ vodId: string; patch: Record<string, unknown> }>;
  saved: Array<{ vodId: string; markdown: string }>;
  renamed: Array<{ vodId: string; title: string }>;
  composed: number;
}

function record(vodId: string, overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    vodId,
    status: "ready",
    title: "РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка",
    url: `https://www.twitch.tv/videos/${vodId}`,
    publishedAt: "2026-09-16T16:54:29Z",
    publishedAtUnix: 1789577669,
    durationSeconds: 13757,
    categories: [],
    source: "auto",
    attempts: 1,
    ...overrides,
  };
}

function servicesWith(captured: Captured, failFor?: string): Services {
  return {
    documents: {
      read: async (vodId: string) => {
        if (vodId === failFor) throw new Error("документ не читается");
        return DOCUMENT;
      },
      save: async (vodId: string, markdown: string) => {
        captured.saved.push({ vodId, markdown });
      },
    },
    models: {
      composeDocumentName: async () => {
        captured.composed += 1;
        return "Выборы, донаты и удостоверение";
      },
    },
    knowledge: {
      renameStream: async (vodId: string, title: string) => {
        captured.renamed.push({ vodId, title });
        return 2;
      },
    },
    registry: {
      patchStream: async (vodId: string, patch: Record<string, unknown>) => {
        captured.patched.push({ vodId, patch });
      },
    },
  } as unknown as Services;
}

function empty(): Captured {
  return { patched: [], saved: [], renamed: [], composed: 0 };
}

describe("имена документам, разобранным до их появления", () => {
  test("запись без имени получает его во всех трёх местах", () => {
    const captured = empty();

    return nameDocumentsWithoutNames([record("1")], servicesWith(captured)).then((named) => {
      expect(named).toBe(1);
      // Документ: имя в шапке.
      expect(captured.saved[0]?.markdown.split("\n")[0]).toBe("# Выборы, донаты и удостоверение");
      // Куски: имя в метаданных — иначе выдача показывала бы прежнее.
      expect(captured.renamed[0]?.title).toBe("Выборы, донаты и удостоверение");
      // Реестр: последним, он же признак готовности.
      expect(captured.patched[0]?.patch["docTitle"]).toBe("Выборы, донаты и удостоверение");
    });
  });

  test("имя пишется в реестр последним", () => {
    // Порядок не косметика: реестр — признак того, что работа сделана. Запиши
    // его первым, сбой на документе оставил бы новое имя в списке и старое в
    // шапке, и это расхождение само бы уже не зажило.
    const order: string[] = [];
    const services = {
      documents: {
        read: async () => DOCUMENT,
        save: async () => {
          order.push("документ");
        },
      },
      models: { composeDocumentName: async () => "Имя" },
      knowledge: {
        renameStream: async () => {
          order.push("куски");
          return 1;
        },
      },
      registry: {
        patchStream: async () => {
          order.push("реестр");
        },
      },
    } as unknown as Services;

    return nameDocumentsWithoutNames([record("1")], services).then(() => {
      expect(order).toEqual(["документ", "куски", "реестр"]);
    });
  });

  test("записи с именем и неразобранные не трогаются", async () => {
    const captured = empty();
    const records = [
      record("1", { docTitle: "Уже есть" }),
      record("2", { status: "failed" }),
      record("3", { status: "skipped" }),
      record("4", { status: "processing" }),
    ];

    expect(await nameDocumentsWithoutNames(records, servicesWith(captured))).toBe(0);
    expect(captured.composed).toBe(0);
    expect(captured.saved).toHaveLength(0);
  });

  test("попытки именования считаются, чтобы не платить за них вечно", async () => {
    // Имя вырабатывается обращением к модели, то есть за деньги. Запись, у
    // которой имя не выходит по причине, которая сама не пройдёт, иначе
    // платила бы за попытку каждый час и бессрочно.
    const captured = empty();

    const named = await nameDocumentsWithoutNames([record("1")], servicesWith(captured, "1"));

    expect(named).toBe(0);
    expect(captured.patched[0]?.patch["nameAttempts"]).toBe(1);
  });

  test("исчерпавшему попытки имя больше не вырабатывают", async () => {
    const captured = empty();

    const named = await nameDocumentsWithoutNames(
      [record("1", { nameAttempts: 3 }), record("2")],
      servicesWith(captured),
    );

    expect(named).toBe(1);
    expect(captured.patched.map((item) => item.vodId)).toEqual(["2"]);
  });

  test("сбой на одной записи не мешает остальным", async () => {
    const captured = empty();

    const named = await nameDocumentsWithoutNames(
      [record("1"), record("2")],
      servicesWith(captured, "1"),
    );

    expect(named).toBe(1);
    // Сбойной достаётся только счёт попытки, имени — нет.
    expect(captured.patched.map((item) => item.vodId)).toEqual(["1", "2"]);
    expect(captured.patched[0]?.patch).toEqual({ nameAttempts: 1 });
    expect(captured.patched[1]?.patch["docTitle"]).toBe("Выборы, донаты и удостоверение");
  });
});
