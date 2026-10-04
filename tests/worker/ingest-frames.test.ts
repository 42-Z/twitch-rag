import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, test } from "vitest";
import type { IngestParams } from "../../src/worker/env.ts";
import { FakeRegistry, network } from "./network.ts";

/**
 * Разбор записи с кадрами целиком — в среде Worker, на настоящих привязках
 * (Workflows, R2) и подменённой сети.
 *
 * Подменены результатами только шаги, не имеющие отношения к кадрам:
 * распознавание (нужен звук и платная модель), имя документа и запись
 * документа в Blob. Остальное идёт по-настоящему: чтение сведений о стримере
 * (подставной реестр), склейка
 * расшифровки, проходы составления (запросы к OpenRouter перехвачены и
 * записываются), индексация (эмбеддинги и векторная база — подмена сети),
 * отметка в реестре, уборка временного.
 *
 * Правила тестирования Workflows:
 * https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
 * — изменения шагов задаются до создания экземпляра, экземпляр обязательно
 * освобождается (`dispose`), иначе его состояние переживёт проверку.
 */

const STREAM = "2878430068";
const R2_HOST = "acct.r2.cloudflarestorage.com";
const OPENROUTER = "https://openrouter.ai/api/v1";
const VECTOR = "https://vector.test";

const frameKey = (at: number): string => `frames/${STREAM}/frame-${String(at).padStart(6, "0")}.jpg`;
const frameUrl = (at: number): string => `https://${R2_HOST}/twitch-audio/${frameKey(at)}?X-Amz-Signature=sig${at}`;
const framesEvery180 = (seconds: number) =>
  Array.from({ length: Math.floor(seconds / 180) }, (_, index) => ({ atSeconds: index * 180, url: frameUrl(index * 180) }));

function params(overrides: Partial<IngestParams> = {}): IngestParams {
  return {
    streamId: STREAM,
    vodId: STREAM,
    partStartSeconds: 0,
    url: `https://www.twitch.tv/videos/${STREAM}`,
    publishedAt: "2026-09-16T16:54:29Z",
    durationSeconds: 1800,
    categories: [{ title: "Just Chatting", startSeconds: 0, endSeconds: 1800 }],
    chunks: [{ index: 0, key: `audio/${STREAM}/chunk-0000.m4a`, offsetSeconds: 0, durationSeconds: 1800 }],
    ...overrides,
  };
}

/** Запрос прохода, каким его увидела модель: участок и адреса картинок в порядке следования. */
interface PassRequest {
  part: { startSeconds: number; endSeconds: number };
  images: string[];
}

/** Адреса картинок во всём теле запроса — где бы они ни лежали. */
function collectImages(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, found);
  } else if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    const image = record["image_url"];
    if (typeof image === "object" && image !== null && typeof (image as { url?: unknown }).url === "string") {
      found.push((image as { url: string }).url);
    }
    for (const value of Object.values(record)) collectImages(value, found);
  }
  return found;
}

/** Эмбеддинг в том виде, в каком его просит SDK: по умолчанию base64 из чисел с плавающей точкой. */
function encodeEmbedding(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Внешние сервисы разбора. `rejectFrames` — модель отказывает запросу с
 * картинками так, как отказывал OpenRouter вживую (`research.md` §6).
 */
function externalServices(options: { rejectFrames?: boolean } = {}) {
  const passes: PassRequest[] = [];
  const registry = new FakeRegistry();

  network.use(
    ...registry.handlers(),
    http.post(`${OPENROUTER}/chat/completions`, async ({ request }) => {
      const text = await request.text();
      const images = collectImages(JSON.parse(text));
      // Сообщение участка последним в запросе: «С 0 по 2790 секунду записи».
      const range = [...text.matchAll(/С (\d+) по (\d+) секунду/g)].at(-1);
      const part = { startSeconds: Number(range?.[1]), endSeconds: Number(range?.[2]) };
      passes.push({ part, images });

      if (options.rejectFrames === true && images.length > 0) {
        return HttpResponse.json(
          {
            error: {
              message: "Provider returned error",
              code: 400,
              metadata: { raw: "origin returned HTTP 404", provider_name: "Meta", provider_error_code: "media_url_origin_error" },
            },
          },
          { status: 400 },
        );
      }

      const sections = [
        {
          title: "Планы на ближайшие стримы",
          text: "Стример обсуждает планы на ближайшие стримы и отвечает на вопросы зрителей.",
          startSeconds: part.startSeconds,
          endSeconds: part.endSeconds,
        },
      ];
      return HttpResponse.json({
        id: "gen-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ sections }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
    http.post(`${OPENROUTER}/embeddings`, async ({ request }) => {
      const body = (await request.json()) as { input: string[]; encoding_format?: string };
      const embedding = [0.1, 0.2, 0.3];
      return HttpResponse.json({
        object: "list",
        model: "test-embedding",
        data: body.input.map((_, index) => ({
          object: "embedding",
          index,
          embedding: body.encoding_format === "float" ? embedding : encodeEmbedding(embedding),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }),
    http.post(`${VECTOR}/upsert`, () => HttpResponse.json({ result: "Success" })),
    http.post(`${VECTOR}/range`, () => HttpResponse.json({ result: { nextCursor: "", vectors: [] } })),
  );
  return { passes, registry };
}

/** Что лежит в хранилище аудио до разбора: расшифровка куска и кадры. */
async function seed(frameSeconds: number[]): Promise<void> {
  await env.AUDIO.put(`transcript/${STREAM}/chunk-0000.txt`, "[10] привет\n[60] разбираем планы на ближайшие стримы", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  for (const at of frameSeconds) await env.AUDIO.put(frameKey(at), "jpeg");
}

async function keysUnder(prefix: string): Promise<string[]> {
  return (await env.AUDIO.list({ prefix })).objects.map((object) => object.key);
}

async function cleanup(): Promise<void> {
  for (const prefix of ["audio/", "transcript/", "frames/"]) {
    const keys = await keysUnder(prefix);
    if (keys.length > 0) await env.AUDIO.delete(keys);
  }
}

/**
 * Запускает разбор с подменой шагов, не связанных с кадрами, и возвращает
 * экземпляр после ожидаемого конца. Экземпляр освобождается здесь же.
 */
async function runIngest(
  input: IngestParams,
  expected: "complete" | "errored",
  extra?: (m: Parameters<Parameters<Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]>[0]>[0]) => Promise<void>,
): Promise<{ error?: { name: string; message: string } }> {
  // Идентификатор держится здесь: у интроспектора своего поля с ним нет, а
  // экземпляр, созданный под другим именем, подмен шагов не получит.
  const id = `ingest-${STREAM}-${crypto.randomUUID()}`;
  const instance = await introspectWorkflowInstance(env.INGEST, id);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      // Подмена применяется только к значению, истинному в смысле JS: `null`,
      // `""`, `0` и `false` миниflare молча пропускает, и шаг выполняется
      // по-настоящему (`replaceResult` в `miniflare/.../workflows/binding.worker.js`).
      // Поэтому у шага без полезного результата он условный, но непустой.
      await m.mockStepResult({ name: "распознать кусок 0" }, { language: "ru", phrases: 3, speechSeconds: 90 });
      await m.mockStepResult({ name: "выработать имя документа" }, "Проверочный разбор");
      await m.mockStepResult({ name: "сохранить документ" }, { saved: true });
      await extra?.(m);
    });
    await env.INGEST.create({ id, params: input });
    await instance.waitForStatus(expected);
    return expected === "errored" ? { error: await instance.getError() } : {};
  } finally {
    await instance.dispose();
  }
}

describe("разбор с кадрами в среде Worker", () => {
  test("каждый проход получает кадры своего участка и только их; кадры убраны после разбора", async () => {
    // 31 кадр — больше тридцати на проход: проходов два, хотя речи на один.
    const frames = framesEvery180(5580);
    expect(frames).toHaveLength(31);
    const { passes, registry } = externalServices();
    await seed(frames.map((frame) => frame.atSeconds));
    try {
      await runIngest(
        params({
          durationSeconds: 5580,
          categories: [{ title: "Just Chatting", startSeconds: 0, endSeconds: 5580 }],
          chunks: [{ index: 0, key: `audio/${STREAM}/chunk-0000.m4a`, offsetSeconds: 0, durationSeconds: 5580 }],
          frames,
        }),
        "complete",
      );

      expect(passes).toHaveLength(2);
      const seen: string[] = [];
      for (const pass of passes) {
        const own = frames
          .filter((frame) => frame.atSeconds >= pass.part.startSeconds && frame.atSeconds < pass.part.endSeconds)
          .map((frame) => frame.url);
        expect(pass.images).toEqual(own);
        seen.push(...pass.images);
      }
      // Каждый кадр ушёл ровно в один проход, чужих нет.
      expect([...seen].sort()).toEqual(frames.map((frame) => frame.url).sort());

      const record = registry.hash(`stream:${STREAM}`);
      expect(record.get("status")).toBe("ready");
      // Кадры были у каждого окна и ни один проход не откатился: пометки нет.
      expect(record.get("reason")).toBe("");
      expect(await keysUnder("frames/")).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("параметры прежнего вида, без кадров: запрос без картинок, разбор доходит до конца", async () => {
    const { passes, registry } = externalServices();
    await seed([]);
    try {
      await runIngest(params(), "complete");

      expect(passes).toHaveLength(1);
      expect(passes[0]?.images).toEqual([]);
      const record = registry.hash(`stream:${STREAM}`);
      expect(record.get("status")).toBe("ready");
      // Вся запись без кадров: 1 800 с — 30 минут.
      expect(record.get("reason")).toBe("Без кадров: 30 мин эфира.");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("модель отвергла кадры: проход переписан без них, разбор доходит до конца", async () => {
    const frames = framesEvery180(1800);
    const { passes, registry } = externalServices({ rejectFrames: true });
    await seed(frames.map((frame) => frame.atSeconds));
    try {
      await runIngest(params({ frames }), "complete");

      // Первый запрос — с кадрами, отвергнут; второй — тот же участок без них.
      expect(passes).toHaveLength(2);
      expect(passes[0]?.images).toHaveLength(frames.length);
      expect(passes[1]?.images).toEqual([]);
      expect(passes[1]?.part).toEqual(passes[0]?.part);

      const record = registry.hash(`stream:${STREAM}`);
      expect(record.get("status")).toBe("ready");
      // Документ написан без кадров — запись говорит, сколько эфира они не видели.
      expect(record.get("reason")).toBe("Без кадров: 30 мин эфира.");
      expect(await keysUnder("frames/")).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("сбой разбора: кадры убраны, расшифровка остаётся, запись помечена отказом", async () => {
    const frames = framesEvery180(1800);
    const { registry } = externalServices();
    await seed(frames.map((frame) => frame.atSeconds));
    try {
      const { error } = await runIngest(params({ frames }), "errored", async (m) => {
        await m.mockStepError({ name: "составить часть 1 из 1" }, new Error("сбой составления"));
      });

      expect(error?.message).toContain("сбой составления");
      expect(await keysUnder("frames/")).toEqual([]);
      // Расшифровка нужна переигровке: проходы без кадров не повторяются, а звук и текст остаются.
      expect(await keysUnder("transcript/")).toContain(`transcript/${STREAM}/full.txt`);
      expect(registry.hash(`stream:${STREAM}`).get("status")).toBe("failed");
    } finally {
      await cleanup();
    }
  }, 60_000);
});
