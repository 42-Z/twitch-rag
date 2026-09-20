import { test, expect, describe } from "vitest";
import { withPartLabel } from "../../src/shared/document-name.ts";

describe("метка части в имени документа", () => {
  test("имя части называет часть", () => {
    expect(withPartLabel("Как разыграли зрителей", { index: 2, count: 3 })).toBe(
      "Как разыграли зрителей (часть 2 из 3)",
    );
  });

  test("у неделёной записи имя не меняется", () => {
    expect(withPartLabel("Как разыграли зрителей", undefined)).toBe("Как разыграли зрителей");
  });

  test("уже помеченное имя повторно не помечается", () => {
    const once = withPartLabel("Имя", { index: 1, count: 2 });
    expect(withPartLabel(once, { index: 1, count: 2 })).toBe(once);
  });
});
