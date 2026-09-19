import { test, expect, describe } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagePage } from "../../src/ui/pages/ManagePage.tsx";
import type { ChannelSummary } from "../../src/ui/lib/registry.ts";
import { addStreamOutcome, type TokenState } from "../../src/ui/lib/owner.ts";

/**
 * Что видно в разделе управления при предъявленном и при непредъявленном
 * токене (FR-020, FR-037 спец. 001).
 *
 * Проверка нужна потому, что прежняя отрисовочная проверка этого раздела
 * держалась за строку «Токен владельца» — заголовок, который виден всегда,
 * независимо от того, пустили владельца дальше или нет. Пропади ограждение
 * `{allowed && …}` — поля открылись бы любому посетителю, а проверки
 * остались бы зелёными.
 *
 * Отрисовка серверная: браузера нет, и тогда же проверяется, что содержимое
 * раздела берётся из свойств, а не из чего-то доступного только в браузере.
 */
const channel: ChannelSummary = {
  login: "5opka",
  displayName: "5opka",
  streamerInfo: "Постоянные собеседники: Соня (sonasheka), Buster.",
};

function render(tokenState: TokenState, withChannel: ChannelSummary | undefined): string {
  return renderToStaticMarkup(
    <ManagePage
      adminToken=""
      onTokenChange={() => undefined}
      tokenState={tokenState}
      channel={withChannel}
      onChanged={() => undefined}
    />,
  );
}

/** Канал подключён — обычный случай для проверок ниже. */
const withChannel = (tokenState: TokenState): string => render(tokenState, channel);

describe("раздел управления и токен владельца", () => {
  test("без верного токена полей не видно", () => {
    for (const state of ["none", "checking", "invalid", "unreachable"] as const) {
      const html = withChannel(state);
      expect(html).toContain("Токен владельца");
      expect(html).not.toContain("О стримере");
      expect(html).not.toContain("Добавить запись вручную");
    }
  });

  test("с верным токеном поля на месте", () => {
    const html = withChannel("valid");
    expect(html).toContain("О стримере");
    expect(html).toContain("Добавить запись вручную");
    expect(html).toContain("Логин канала на Twitch");
  });

  test("сведения о стримере объяснены, а не только названы", () => {
    // Пустое поле владелец не заполнит: из одного заголовка неясно, что туда
    // писать и что из этого изменится.
    const html = withChannel("valid");
    expect(html).toContain("уходят в инструкцию");
    expect(html).toContain("Действует на следующие разборы");
  });

  test("без подключённого канала поле о стримере не показывается", () => {
    // Сведения живут в записи канала: без канала их негде хранить, и
    // заполненное поле пропало бы при перезагрузке.
    expect(render("valid", undefined)).not.toContain("О стримере");
  });
});

describe("подпись после добавления записи", () => {
  test("при начале разбора — прежний текст и вид успеха", () => {
    expect(addStreamOutcome({ status: "processing" })).toEqual({
      kind: "success",
      text: "Запись принята в обработку.",
    });
  });

  test("при пропуске — причина пропуска, а не обещание разбора", () => {
    // Иначе владелец пойдёт искать запись в списке разобранных и не найдёт.
    expect(addStreamOutcome({ status: "skipped", reason: "Запись короче трёх минут — разбирать в ней нечего." }))
      .toEqual({ kind: "note", text: "Запись короче трёх минут — разбирать в ней нечего." });
  });

  test("пропуск без причины не оставляет пустую подпись", () => {
    const outcome = addStreamOutcome({ status: "skipped" });
    expect(outcome.kind).toBe("note");
    expect(outcome.text).not.toBe("");
  });
});
