// Переиндексация готового документа эфира боевой нарезкой (`buildChunks`, `src/shared/sections.ts`) — без
// составления документа заново: разделы те же, меняются только куски индекса. Нужна, чтобы сравнить две нарезки
// на одном и том же документе.
//
//   node --env-file=.env specs/008-coarser-sections/research/scripts/reindex-doc.mjs <документ.md> <идентификатор записи>
//
// Метаданные записи (имя документа, дата, язык) берутся из уже лежащего в индексе куска `<запись>:0:0`. Старые
// куски, которых нет среди новых, убираются так же, как в разборе (`Knowledge.removeExcept`). Пишет в боевой
// индекс: цена — эмбеддинги, доли цента.
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { Index } from "@upstash/vector";
import { buildChunks } from "../../../../src/shared/chunks.ts";
import { Knowledge, chunkId } from "../../../../src/shared/knowledge.ts";

const [docPath, streamId] = process.argv.slice(2);
if (docPath === undefined || streamId === undefined) {
  console.error("Нужны: файл документа и идентификатор записи");
  process.exit(1);
}

const H = /^## (.+?)\s*\[(\d+):(\d\d):(\d\d)\s*—\s*(\d+):(\d\d):(\d\d)(?:\s*·\s*([^\]]*))?\]\s*$/;
const sections = [];
let current = null;
for (const line of readFileSync(docPath, "utf8").split("\n")) {
  const m = line.match(H);
  if (m) {
    current = {
      title: m[1],
      text: "",
      startSeconds: +m[2] * 3600 + +m[3] * 60 + +m[4],
      endSeconds: +m[5] * 3600 + +m[6] * 60 + +m[7],
      category: (m[8] ?? "").trim(),
    };
    sections.push(current);
  } else if (current !== null) current.text += `${line}\n`;
}
for (const section of sections) section.text = section.text.trim();

const config = { url: process.env.UPSTASH_VECTOR_REST_URL, token: process.env.UPSTASH_VECTOR_REST_TOKEN };
const index = new Index(config);
const [existing] = await index.fetch([chunkId(streamId, 0, 0)], { includeMetadata: true });
if (existing === null || existing === undefined) throw new Error(`в индексе нет куска ${chunkId(streamId, 0, 0)}`);
const meta = existing.metadata;

const chunks = buildChunks({
  sections,
  stream: { streamId, vodId: meta.vodId, publishedAt: meta.publishedAt },
  language: meta.language,
  docTitle: meta.title,
});

const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const knowledge = new Knowledge(config);
const BATCH = 128;
for (let offset = 0; offset < chunks.length; offset += BATCH) {
  const batch = chunks.slice(offset, offset + BATCH);
  const response = await client.embeddings.create({ model: "openai/text-embedding-3-small", input: batch.map((c) => c.data) });
  await knowledge.upsert(batch.map((chunk, i) => ({ ...chunk, vector: response.data[i].embedding })));
}
const fresh = new Set(chunks.map((c) => chunkId(c.streamId, c.sectionIndex, c.chunkIndex)));
const removed = await knowledge.removeExcept(streamId, fresh);
console.log(`разделов ${sections.length}, кусков записано ${chunks.length}, прежних убрано ${removed}`);
