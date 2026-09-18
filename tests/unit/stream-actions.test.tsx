import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamActions } from "../../src/ui/components/StreamActions.tsx";
import type { StreamSummary } from "../../src/ui/lib/registry.ts";

/**
 * Повторный разбор доступен для записи в любом состоянии (FR-028, FR-034).
 *
 * Проверка появилась по делу: действия жили внутри отрисовки разобранных, и у
 * записи со статусом «пропущено» или «не удалось» не было ни одной кнопки.
 * Владелец не мог вернуть её к работе со страницы — а именно к этому его
 * отправляет запись о пропуске и отвергнутый по FR-030 повторный запуск.
 *
 * Отрисовка серверная: список тянет данные эффектом, который при ней не
 * выполняется, поэтому действия вынесены отдельным узлом и рисуются сразу.
 */
function summary(status: StreamSummary["status"], overrides: Partial<StreamSummary> = {}): StreamSummary {
  return {
    vodId: "2875806701",
    status,
    title: "РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка",
    url: "https://www.twitch.tv/videos/2875806701",
    publishedAt: "2026-09-16T16:54:29Z",
    durationSeconds: 13757,
    categories: [],
    sectionCount: 16,
    ...overrides,
  };
}

const noop = (): undefined => undefined;
const nothing = async (): Promise<void> => undefined;

function render(stream: StreamSummary, props: Partial<Parameters<typeof StreamActions>[0]> = {}): string {
  return renderToStaticMarkup(
    <StreamActions
      stream={stream}
      onOpen={noop}
      onReparse={nothing}
      onDelete={nothing}
      onFailed={noop}
      onDone={noop}
      {...props}
    />,
  );
}

describe("действия рядом с записью", () => {
  test("разобрать заново можно в любом состоянии", () => {
    for (const status of ["ready", "processing", "failed", "skipped"] as const) {
      const html = render(summary(status));
      expect(html).toContain("Разобрать заново");
      expect(html).toContain("Удалить");
    }
  });

  test("открыть документ предлагается только там, где он есть", () => {
    expect(render(summary("ready"))).toContain("Открыть документ");
    // У пропущенной и неудачной записи документа нет: предлагать открыть
    // нечего, а кнопка вела бы на пустую страницу.
    expect(render(summary("skipped"))).not.toContain("Открыть документ");
    expect(render(summary("failed"))).not.toContain("Открыть документ");
  });

  test("без права управлять действий нет", () => {
    const html = render(summary("ready"), { onReparse: undefined, onDelete: undefined });
    expect(html).toContain("Открыть документ");
    expect(html).not.toContain("Разобрать заново");
    expect(html).not.toContain("Удалить");
  });
});
