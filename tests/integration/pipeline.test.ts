/**
 * Сквозная проверка на живом сервисе: от кусков аудио до раздела, который
 * находится поиском.
 *
 * Тест тратит настоящие деньги (распознавание, модель, эмбеддинги) и работает
 * только против развёрнутого сервиса, поэтому запускается по явному согласию:
 *
 *   npm run test:integration
 *
 * Берётся самая короткая запись канала — тридцать семь секунд: путь тот же,
 * что у пятичасового эфира, а стоит доли копейки.
 */

import { test, expect, describe } from "vitest";
import { Redis } from "@upstash/redis";
import { AwsClient } from "aws4fetch";

const ENABLED = process.env["INTEGRATION"] === "1";
const BASE = process.env["WORKER_URL"] ?? "https://twitch-rag.crbanana.workers.dev";
const VOD_ID = process.env["INTEGRATION_VOD_ID"] ?? "2842472840";
const TIMEOUT_MS = 15 * 60 * 1000;

const redis = new Redis({
  url: process.env["UPSTASH_REDIS_REST_URL"] ?? "",
  token: process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "",
});

async function streamRecord(): Promise<Record<string, unknown> | null> {
  return await redis.hgetall(`stream:${VOD_ID}`);
}

async function waitForOutcome(): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = String((await streamRecord())?.["status"] ?? "");
    if (status === "ready" || status === "failed" || status === "skipped") return status;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error("разбор не завершился за отведённое время");
}

async function audioKeysLeft(): Promise<number> {
  const aws = new AwsClient({
    accessKeyId: process.env["R2_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["R2_SECRET_ACCESS_KEY"] ?? "",
    service: "s3",
    region: "auto",
  });
  const url = `https://${process.env["R2_ACCOUNT_ID"]}.r2.cloudflarestorage.com/${process.env["R2_BUCKET"]}?list-type=2&prefix=audio/${VOD_ID}/`;
  const body = await (await aws.fetch(url)).text();
  return [...body.matchAll(/<Key>/g)].length;
}

function admin(): Record<string, string> {
  return {
    authorization: `Bearer ${process.env["APP_ADMIN_TOKEN"] ?? ""}`,
    "content-type": "application/json",
  };
}

describe.skipIf(!ENABLED)("сквозной разбор короткой записи", () => {
  test(
    "запись проходит путь до раздела, который находится поиском",
    async () => {
      // Прошлый прогон этого же теста не должен подменять результат.
      await fetch(`${BASE}/api/streams/${VOD_ID}`, { method: "DELETE", headers: admin() });

      const started = await fetch(`${BASE}/api/streams`, {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ url: `https://www.twitch.tv/videos/${VOD_ID}` }),
      });
      expect(started.status).toBe(202);

      const outcome = await waitForOutcome();
      const record = await streamRecord();
      // `skipped` — законный исход для записи без речи, но тогда проверять
      // нечего: тест требует записи, на которой что-то говорят.
      expect(outcome).toBe("ready");

      expect(Number(record?.["sectionCount"])).toBeGreaterThan(0);
      expect(String(record?.["docPath"])).toBe(`streams/${VOD_ID}.md`);

      const document = await (await fetch(`${BASE}/api/streams/${VOD_ID}/document`)).text();
      expect(document).toContain("## ");

      // Раздел находится поиском по собственному заголовку: если кусок дошёл
      // до индекса, этот запрос обязан вернуть именно его.
      const title = /^## (.+?) \[/m.exec(document)?.[1] ?? "";
      expect(title).not.toBe("");

      const found = await (
        await fetch(`${BASE}/api/knowledge/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: title, topK: 5 }),
        })
      ).json();
      const ids = (found.documents ?? []).map((d: { id: string }) => d.id.split(":")[0]);
      expect(ids).toContain(VOD_ID);

      // Расшифровка нигде не остаётся: ни в реестре, ни в документе, ни в R2.
      expect(Object.keys(record ?? {})).not.toContain("transcript");
      expect(await audioKeysLeft()).toBe(0);

      // Убирается только удавшийся прогон: после провала запись нужна, чтобы
      // посмотреть, на чём всё встало.
      await fetch(`${BASE}/api/streams/${VOD_ID}`, { method: "DELETE", headers: admin() });
    },
    TIMEOUT_MS,
  );
});
