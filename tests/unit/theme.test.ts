import { test, expect, describe } from "bun:test";

/**
 * Тёмная тема включается сама, по предпочтению браузера.
 *
 * Проверка сторожит тихую поломку: `shadcn add` дописывает в стили
 * `@custom-variant dark (&:is(.dark *))`, после чего `dark:` перестаёт
 * зависеть от `prefers-color-scheme` и ждёт класса, которого никто не ставит.
 * Снаружи это выглядит как «тёмная тема не работает».
 */
const css = await Bun.file(new URL("../../styles/globals.css", import.meta.url)).text();

describe("тёмная тема", () => {
  test("токены тёмной темы заданы под предпочтение браузера", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  test("вариант dark не привязан к классу, которого никто не ставит", () => {
    expect(css).not.toContain("@custom-variant dark");
    expect(css).not.toContain(".dark {");
  });

  test("тёмная и светлая темы задают одни и те же токены", () => {
    // Разошедшийся набор токенов даёт неокрашенные места в одной из тем.
    const names = (block: string) => [...block.matchAll(/--([a-z-]+):/g)].map((m) => m[1]).sort();

    const light = /:root \{([\s\S]*?)\n\}/.exec(css)?.[1];
    const dark = /prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(css)?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();

    const inLight = names(light as string).filter((name) => name !== "radius" && name !== "scheme");
    const inDark = names(dark as string).filter((name) => name !== "radius" && name !== "scheme");
    expect(inDark).toEqual(inLight);
  });
});
