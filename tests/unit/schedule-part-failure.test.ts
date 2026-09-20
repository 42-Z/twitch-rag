import { test, expect, describe } from "vitest";
import { selectNextVideo, retireExhausted } from "../../src/worker/schedule.ts";
import { MAX_ATTEMPTS, type StreamRecord } from "../../src/shared/registry.ts";
import type { TwitchVideo } from "../../src/shared/twitch.ts";

/**
 * Отказ одной части не трогает остальные: состояние, попытки и исчерпание
 * считаются на часть (FR-007, FR-008).
 */
const NOW = 2000000000;
const H = 3600;

const video: TwitchVideo = {
  vodId: "1",
  title: "эфир",
  url: "https://www.twitch.tv/videos/1",
  publishedAt: new Date(1900000000 * 1000).toISOString(),
  publishedAtUnix: 1900000000,
  durationSeconds: 8 * H,
  streamId: "s-1",
  viewable: "public",
  mutedSegments: [],
};

function part(index: number, status: StreamRecord["status"], attempts = 1): StreamRecord {
  return {
    streamId: `1-p${index}`,
    vodId: "1",
    status,
    title: "эфир",
    url: video.url,
    publishedAt: video.publishedAt,
    publishedAtUnix: video.publishedAtUnix,
    durationSeconds: 4 * H,
    categories: [],
    source: "auto",
    attempts,
    part: index,
    partCount: 2,
  };
}

const known = (...records: StreamRecord[]) => new Map(records.map((record) => [record.streamId, record]));

describe("отказ одной части", () => {
  test("сорвалась вторая — повторяется только она", () => {
    const next = selectNextVideo([video], known(part(1, "ready"), part(2, "failed", 1)), 0, NOW);
    expect(next?.part.index).toBe(2);
  });

  test("исчерпание попыток переводит в пропущенные только эту часть", async () => {
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const services = {
      registry: {
        patchStream: async (id: string, patch: Record<string, unknown>) => {
          patches.push({ id, patch });
        },
      },
    } as unknown as Parameters<typeof retireExhausted>[1];
    const all = known(part(1, "ready", 1), part(2, "failed", MAX_ATTEMPTS));

    await retireExhausted(all, services);

    expect(patches.map((item) => item.id)).toEqual(["1-p2"]);
    expect(patches[0]?.patch["status"]).toBe("skipped");
    expect(all.get("1-p1")?.status).toBe("ready");
    expect(all.get("1-p2")?.status).toBe("skipped");
  });

  test("после исчерпания второй части автоматика не берёт ни её, ни первую", () => {
    const closed = known(part(1, "ready"), part(2, "skipped", MAX_ATTEMPTS));
    expect(selectNextVideo([video], closed, 0, NOW)).toBeUndefined();
  });

  test("попытки первой части не растут из-за отказа второй", () => {
    const records = known(part(1, "ready", 1), part(2, "failed", 2));
    void selectNextVideo([video], records, 0, NOW);
    expect(records.get("1-p1")?.attempts).toBe(1);
  });
});
