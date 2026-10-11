// Проверка поиска по знаниям на одной записи: вопросы с известными минутами эфира.
//
//   node specs/008-coarser-sections/research/scripts/search-check.mjs <метка> [адрес сервиса]
//
// Вопросы и окна — в ../data/search-questions.json (каталог в .gitignore: вопросы пересказывают речь эфира).
// Формат: { streamId, items: [{ id, from, to, query }] }, from/to — секунды эфира, где звучит нужный факт.
// Ответ засчитан, если среди выданных разделов есть раздел нужного эфира, пересекающийся с окном.
// Результат пишется в ../data/search-<метка>.json.

import { readFile, writeFile } from "node:fs/promises";

const [label, base = "https://twitch-rag.crbanana.workers.dev"] = process.argv.slice(2);
if (label === undefined) {
  console.error("Укажите метку прогона: node search-check.mjs <метка> [адрес]");
  process.exit(1);
}

const questions = JSON.parse(
  await readFile(new URL("../data/search-questions.json", import.meta.url), "utf8"),
);
const { streamId } = questions;
const TOP_K = 5;
const PAUSE_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(query) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${base}/api/knowledge/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK: TOP_K }),
    });
    if (response.status === 429) {
      await sleep(61_000);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }
  throw new Error("Три отказа по частоте подряд");
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const rows = [];
for (const item of questions.items) {
  const payload = await ask(item.query);
  const documents = payload.documents ?? [];
  const overlaps = (doc) =>
    doc.stream.streamId === streamId && doc.startSeconds < item.to && doc.endSeconds > item.from;
  const firstHit = documents.findIndex(overlaps);
  const hit = firstHit === -1 ? null : documents[firstHit];
  rows.push({
    id: item.id,
    query: item.query,
    window: [item.from, item.to],
    found: payload.found === true,
    returned: documents.length,
    fromTarget: documents.filter((doc) => doc.stream.streamId === streamId).length,
    rank: firstHit === -1 ? null : firstHit + 1,
    hit:
      hit === null
        ? null
        : {
            topic: hit.topic,
            start: hit.startSeconds,
            end: hit.endSeconds,
            span: hit.endSeconds - hit.startSeconds,
            chars: hit.text.length,
            score: hit.score,
          },
    results: documents.map((doc) => ({
      streamId: doc.stream.streamId,
      topic: doc.topic,
      start: doc.startSeconds,
      end: doc.endSeconds,
      chars: doc.text.length,
      score: doc.score,
    })),
  });
  await sleep(PAUSE_MS);
}

const hits = rows.filter((row) => row.rank !== null);
const summary = {
  label,
  base,
  streamId,
  questions: rows.length,
  hitAt1: rows.filter((row) => row.rank === 1).length,
  hitAt3: rows.filter((row) => row.rank !== null && row.rank <= 3).length,
  hitAt5: hits.length,
  missed: rows.filter((row) => row.rank === null).map((row) => row.id),
  notFoundAtAll: rows.filter((row) => !row.found).map((row) => row.id),
  hitSectionChars: {
    median: median(hits.map((row) => row.hit.chars)),
    mean: hits.length === 0 ? null : Math.round(hits.reduce((s, r) => s + r.hit.chars, 0) / hits.length),
  },
  hitSectionSeconds: { median: median(hits.map((row) => row.hit.span)) },
};

const outPath = new URL(`../data/search-${label}.json`, import.meta.url);
await writeFile(outPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
for (const row of rows) {
  const where = row.hit === null ? "нет" : `#${row.rank} ${row.hit.start}–${row.hit.end} с, ${row.hit.chars} зн., ${row.hit.score.toFixed(3)}`;
  console.log(`${row.id}  ${where}`);
}
