import { test, expect, describe } from "vitest";
import { renderDocumentHeader } from "../../src/shared/documents.ts";
import { documentName } from "../../src/shared/document-name.ts";
import { toSummary } from "../../src/ui/lib/registry.ts";

/**
 * Имя документа на всём пути: от записи в реестре до шапки документа.
 *
 * Три места берут имя из трёх разных хранилищ и в трёх разных форматах, и
 * расхождение между ними — дефект (FR-025). Форматы здесь записаны так, как
 * их отдают сами хранилища:
 *
 * - реестр странице — плоский список `HGETALL` из голого REST, строки как есть;
 * - реестр Worker'у — клиент хранилища разбирает значения как JSON, поэтому
 *   имя приводится к строке;
 * - метаданные куска в векторной базе — разбор этого пути в
 *   `tests/contract/knowledge-search.test.ts`.
 */
describe("имя документа в шапке", () => {
  test("первой строкой идёт имя, а не заголовок с площадки", () => {
    const header = renderDocumentHeader({
      name: "Как разыграли зрителей треком на час",
      publishedAt: "2026-09-16T16:54:29Z",
      durationSeconds: 13740,
      categories: ["Just Chatting"],
    });

    expect(header.startsWith("# Как разыграли зрителей треком на час\n")).toBe(true);
    expect(header).toContain("**Эфир**: 2026-09-16");
    expect(header).not.toContain("!донат");
  });

  test("пустой список категорий не оставляет пустой строки", () => {
    const header = renderDocumentHeader({
      name: "Разбор движка",
      publishedAt: "2026-09-16T16:54:29Z",
      durationSeconds: 600,
      categories: [],
    });

    expect(header).not.toContain("**Категории**");
  });
});

describe("имя документа из реестра", () => {
  test("запись читается из плоского ответа хранилища", () => {
    // Ровно тот вид, в каком HGETALL приходит странице по REST: поле,
    // значение, поле, значение — и всё строками.
    const summary = toSummary([
      "vodId", "2875806701",
      "status", "ready",
      "title", "РАССКАЗЫВАЮ ИСТОРИИ // !донат",
      "docTitle", "Как разыграли зрителей треком на час",
      "publishedAt", "2026-09-16T16:54:29Z",
      "durationSeconds", "13740",
      "sectionCount", "18",
      "categories", "[]",
    ]);

    expect(summary?.docTitle).toBe("Как разыграли зрителей треком на час");
    expect(summary?.title).toBe("РАССКАЗЫВАЮ ИСТОРИИ // !донат");
    expect(summary?.durationSeconds).toBe(13740);
    expect(documentName(summary!)).toBe("Как разыграли зрителей треком на час");
  });

  test("заголовок с площадки именем не подставляется", () => {
    // FR-027: он кликбейт и о содержании эфира не говорит, а показанный там,
    // где ждут имя, выдаёт себя за имя документа. Запись, разобранная до
    // появления имён, имени не имеет — так и показывается, а место показа
    // решает, чем её опознать.
    const summary = toSummary(["vodId", "1", "status", "ready", "title", "Старая запись"]);

    expect(summary?.docTitle).toBeUndefined();
    expect(documentName(summary!)).toBe("");
  });

  test("пустое имя читается как отсутствие имени", () => {
    const summary = toSummary(["vodId", "1", "status", "ready", "title", "Старая запись", "docTitle", ""]);

    expect(summary?.docTitle).toBeUndefined();
    expect(documentName(summary!)).toBe("");
  });

  test("запись без vodId не превращается в пустую строку списка", () => {
    expect(toSummary(["status", "ready"])).toBeUndefined();
  });
});
