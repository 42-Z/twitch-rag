import { test, expect, describe } from "vitest";
import { recordLabel } from "../../src/ui/lib/format.ts";

describe("как запись называется в списке", () => {
  test("у записи с именем — имя (у части метка уже в имени)", () => {
    expect(recordLabel({ docTitle: "Как разыграли (часть 2 из 3)", publishedAt: "2026-09-16T16:54:29Z", part: 2, partCount: 3 })).toBe(
      "Как разыграли (часть 2 из 3)",
    );
  });

  test("у части без имени — дата и часть, иначе две строки за один день читались бы как сбой", () => {
    const label = recordLabel({ publishedAt: "2026-09-16T16:54:29Z", part: 2, partCount: 3 });
    expect(label).toMatch(/2026/);
    expect(label.endsWith("· часть 2 из 3")).toBe(true);
  });

  test("у неделёной записи без имени — только дата", () => {
    expect(recordLabel({ publishedAt: "2026-09-16T16:54:29Z" })).not.toContain("часть");
  });
});
