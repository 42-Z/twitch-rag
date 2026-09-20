import { test, expect, describe, vi } from "vitest";

vi.stubEnv("VITE_REGISTRY_URL", "https://registry.test");
vi.stubEnv("VITE_REGISTRY_READONLY_TOKEN", "readonly-token");

const { orderForList } = await import("../../src/ui/lib/registry.ts");
import type { StreamSummary } from "../../src/ui/lib/registry.ts";

const item = (streamId: string, publishedAtUnix: number, overrides: Partial<StreamSummary> = {}): StreamSummary => ({
  streamId,
  vodId: streamId.split("-")[0] as string,
  status: "ready",
  title: "",
  url: "",
  publishedAt: "",
  publishedAtUnix,
  durationSeconds: 3600,
  categories: [],
  sectionCount: 1,
  ...overrides,
});

/**
 * Индекс читается от новых к старым, и вторая часть эфира стояла бы выше
 * первой: страница обязана держать части подряд и по порядку (FR-011).
 */
describe("порядок списка", () => {
  const H = 3600;
  const part = (vod: string, index: number, start: number, broadcast: number) =>
    item(`${vod}-p${index}`, broadcast + start, { part: index, partCount: 2, partStartSeconds: start });

  test("эфиры от новых к старым, части внутри эфира по номеру", () => {
    const old = 1000000;
    const recent = old + 20 * H;
    const shuffled = [
      part("1", 2, 3 * H, old),
      item("2", recent),
      part("1", 1, 0, old),
    ];
    // Так индекс и отдаёт: свежие первыми.
    const fromIndex = [...shuffled].sort((a, b) => b.publishedAtUnix - a.publishedAtUnix);

    expect(orderForList(fromIndex).map((stream) => stream.streamId)).toEqual(["2", "1-p1", "1-p2"]);
  });

  test("два разных эфира не смешиваются, даже если вторая часть старого новее первого нового", () => {
    const first = 1000000;
    const second = first + 2 * H; // новый эфир начался, пока старый ещё шёл
    const list = [
      item("2", second),
      part("1", 2, 3 * H, first),
      part("1", 1, 0, first),
    ];
    expect(orderForList(list).map((stream) => stream.streamId)).toEqual(["2", "1-p1", "1-p2"]);
  });

  test("пустой список и записи без частей не падают", () => {
    expect(orderForList([])).toEqual([]);
    expect(orderForList([item("1", 5), item("2", 9)]).map((stream) => stream.streamId)).toEqual(["2", "1"]);
  });
});
