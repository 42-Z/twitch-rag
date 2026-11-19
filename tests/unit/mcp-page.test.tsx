import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChannelSummary } from "../../src/ui/lib/registry.ts";

/**
 * Раздел MCP показывает то, что получает ассистент, а не рассказ о ресурсе.
 * Проверяются все четыре состояния: текст, пустое поле, отказ чтения и
 * ожидание. Отрисовка серверная — как в соседних проверках страниц.
 */
const fakeWindow = {
  location: { pathname: "/assistant", origin: "https://example.test" },
  addEventListener(): void {},
  removeEventListener(): void {},
};
(globalThis as Record<string, unknown>).window = fakeWindow;

const { McpPage } = await import("../../src/ui/pages/McpPage.tsx");

const channel: ChannelSummary = {
  login: "5opka",
  displayName: "5opka",
  agentStreamerInfo: "5opka — Кирилл Баранов. Канал про общение: истории из жизни, Minecraft, музыка.",
};

interface Props {
  channel: ChannelSummary | undefined;
  loaded: boolean;
  error: string | undefined;
}

function render(props: Props): string {
  return renderToStaticMarkup(<McpPage {...props} />);
}

describe("раздел MCP и сведения о стримере", () => {
  test("заполненное поле — виден текст ресурса", () => {
    const html = render({ channel, loaded: true, error: undefined });

    expect(html).toContain("Общая информация о стримере");
    expect(html).toContain("5opka — Кирилл Баранов");
    expect(html).toContain('href="/manage"');
  });

  test("пустое поле — сказано, что ресурса нет, и где заполнить", () => {
    const html = render({ channel: { ...channel, agentStreamerInfo: undefined }, loaded: true, error: undefined });

    expect(html).toContain("ресурса нет");
    expect(html).toContain('href="/manage"');
  });

  test("отказ чтения — ошибка, а не «ресурса нет»", () => {
    const html = render({
      channel: undefined,
      loaded: true,
      error: "Реестр сейчас недоступен. Попробуйте обновить страницу.",
    });

    expect(html).toContain("Не удалось получить сведения");
    expect(html).toContain("Реестр сейчас недоступен. Попробуйте обновить страницу.");
    expect(html).not.toContain("ресурса нет");
  });

  test("пока не прочитано — ожидание", () => {
    const html = render({ channel: undefined, loaded: false, error: undefined });

    expect(html).toContain('aria-label="Загрузка сведений о стримере"');
  });
});
