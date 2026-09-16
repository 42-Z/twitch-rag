import { test, expect, describe } from "bun:test";
import { matchRoute, knowledgeDocumentPath, ROUTES } from "../../src/ui/lib/routes.ts";

/**
 * Разбор адреса — то, на чём держится обещание «раздел открывается по прямой
 * ссылке»: ссылку передают, вставляют в строку браузера, и она должна открыть
 * именно тот раздел.
 */
describe("разбор адреса", () => {
  test("каждый раздел открывается по своему адресу", () => {
    for (const route of ROUTES) {
      expect(matchRoute(route.path).route.path).toBe(route.path);
    }
  });

  test("признаки и адреса разделов не повторяются", () => {
    // По признаку выбирается страница: два раздела с одним признаком показали бы
    // одну и ту же страницу по двум разным адресам.
    const ids = ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("документ открывается по адресу внутри знаний", () => {
    const matched = matchRoute("/knowledge/2873255697");
    expect(matched.route.path).toBe("/knowledge");
    expect(matched.vodId).toBe("2873255697");
  });

  test("хвостовой слэш не мешает", () => {
    expect(matchRoute("/assistant/").route.path).toBe("/assistant");
    expect(matchRoute("/knowledge/2873255697/").vodId).toBe("2873255697");
  });

  test("адрес раздела не совпадает с адресом MCP-сервера", () => {
    // По `/mcp` отвечает сам сервер ассистента — страница там не откроется.
    expect(ROUTES.some((route) => route.path === "/mcp")).toBe(false);
  });

  test("неизвестный адрес отдаёт главную, а не пустоту", () => {
    // Ссылка с опечаткой не должна показывать пустую страницу.
    expect(matchRoute("/чего-то-нет").route.path).toBe("/");
    expect(matchRoute("/knowledge/не-число").route.path).toBe("/knowledge");
    expect(matchRoute("/knowledge/").route.path).toBe("/knowledge");
  });

  test("адрес документа собирается из идентификатора", () => {
    expect(knowledgeDocumentPath("2873255697")).toBe("/knowledge/2873255697");
  });
});
