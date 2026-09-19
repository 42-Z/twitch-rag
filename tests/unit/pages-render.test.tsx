import { test, expect, describe } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MENU_ROUTES, ROUTES, type RouteId } from "../../src/ui/lib/routes.ts";

/**
 * Каждый раздел при открытии по своему адресу показывает своё содержимое.
 *
 * Повод: раздел MCP однажды уже не отрисовался — страница была в таблице
 * разделов, но её адрес не совпал с тем, по которому её выбирали. Снаружи это
 * выглядело как пустая страница с одной шапкой, и ни типы, ни тесты разбора
 * адреса такого не ловят: набор страниц сходился с таблицей по типам, а
 * содержимое не появлялось.
 */

// Отрисовка серверная: браузера нет, а страницы читают адрес и начало отсчёта
// при отрисовке. Эффекты при этом не выполняются, поэтому в сеть никто не идёт
// и подставлять ответы не нужно.
const fakeWindow = {
  location: { pathname: "/", origin: "https://example.test" },
  addEventListener(): void {},
  removeEventListener(): void {},
};
(globalThis as Record<string, unknown>).window = fakeWindow;

const { App } = await import("../../src/ui/App.tsx");

/** Что видно в разделе, когда данных ещё нет. */
const MARKERS: Record<RouteId, string> = {
  home: "Сейчас в базе",
  mcp: "Подключить ассистента",
  api: "Ограничение частоты",
  // Список тянется из реестра уже в браузере, поэтому при отрисовке без
  // браузера видно только ожидание — оно и служит признаком раздела.
  knowledge: "Загрузка списка трансляций",
  manage: "Токен владельца",
};

function renderAt(path: string): string {
  fakeWindow.location.pathname = path;
  return renderToStaticMarkup(<App />);
}

describe("разделы", () => {
  for (const route of ROUTES) {
    test(`«${route.title}» открывается по адресу ${route.path} и показывает содержимое`, () => {
      const html = renderAt(route.path);
      expect(html).toContain(MARKERS[route.id]);
      // Название раздела стоит и в шапке, и в меню — оно не доказывает, что
      // страница отрисовалась, поэтому проверяется отдельно от содержимого.
      expect(html).toContain(route.title);
    });
  }

  test("меню перечисляет все разделы", () => {
    const html = renderAt("/");
    for (const route of ROUTES) {
      expect(html).toContain(`href="${route.path}"`);
    }
  });

  test("управление стоит внизу меню, после разделов с содержимым", () => {
    const html = renderAt("/");
    const manage = html.indexOf('href="/manage"');
    expect(manage).toBeGreaterThan(-1);
    for (const route of MENU_ROUTES) {
      expect(html.indexOf(`href="${route.path}"`)).toBeLessThan(manage);
    }
  });

  test("подписей с объяснением разделов в шапке нет", () => {
    // Раздел назван в меню и в заголовке; пересказывать его назначение рядом
    // с названием — лишний текст.
    const html = renderAt("/");
    expect(html).not.toContain("Что это за сервис");
  });

  test("содержимое одного раздела не показывается в другом", () => {
    // Иначе проверка выше проходила бы на любой странице.
    expect(renderAt("/")).not.toContain(MARKERS.mcp);
    expect(renderAt("/assistant")).not.toContain(MARKERS.home);
  });

  test("неизвестный адрес открывает главную, а не пустую страницу", () => {
    expect(renderAt("/чего-то-нет")).toContain(MARKERS.home);
  });
});
