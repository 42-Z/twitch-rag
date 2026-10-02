/**
 * Список и уборка ключей кадров в бакете аудио.
 *
 * Нужна двум проверкам: после ручного прогона бокса убрать за ним пробные
 * объекты, а после разбора на выпущенном сервисе убедиться, что в `frames/`
 * пусто (SC-008). Ключи R2 берутся из `.env`.
 *
 *   node --env-file=.env specs/007-stream-frames/research/scripts/r2-frames.ts list --prefix frames/
 *   node --env-file=.env specs/007-stream-frames/research/scripts/r2-frames.ts cleanup --prefix frames/2878430068-p9/
 *
 * `cleanup` принимает только префикс одной записи (`frames/<id>/` или
 * `audio/<id>/` — пробный прогон бокса оставляет и звук): общий `frames/` снёс
 * бы кадры разбора, который идёт в эту минуту.
 */

import { AwsClient } from "aws4fetch";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`нужен --${name}`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`не задана переменная ${name}`);
  return value;
}

const bucket = process.env["R2_BUCKET"] ?? "twitch-audio";
const endpoint = `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${bucket}`;
const client = new AwsClient({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  service: "s3",
  region: "auto",
});

/** Ключи по префиксу — ListObjectsV2 с продолжением, пока ответ усечён. */
async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const url = new URL(endpoint);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (token !== undefined) url.searchParams.set("continuation-token", token);

    const response = await client.fetch(url);
    if (!response.ok) throw new Error(`R2 ответил ${response.status} на список`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(match[1] ?? ""));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (token !== undefined);
  return keys;
}

function decodeXml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

const command = process.argv[2];
const prefix = arg("prefix");

if (command === "list") {
  const keys = await listKeys(prefix);
  console.log(`${prefix}: ${keys.length} ключей`);
  for (const key of keys.slice(0, 10)) console.log(`  ${key}`);
  if (keys.length > 10) console.log(`  … и ещё ${keys.length - 10}`);
} else if (command === "cleanup") {
  if (!/^(frames|audio)\/[A-Za-z0-9-]+\/$/.test(prefix)) {
    throw new Error("cleanup принимает префикс одной записи: frames/<идентификатор>/ или audio/<идентификатор>/");
  }
  const keys = await listKeys(prefix);
  for (const key of keys) {
    const response = await client.fetch(`${endpoint}/${key}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`R2 ответил ${response.status} на удаление ${key}`);
  }
  const left = await listKeys(prefix);
  console.log(`${prefix}: удалено ${keys.length}, осталось ${left.length}`);
  if (left.length > 0) process.exitCode = 1;
} else {
  throw new Error("команда: list или cleanup");
}
