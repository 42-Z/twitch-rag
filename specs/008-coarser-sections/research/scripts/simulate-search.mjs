// Имитация поиска по документу одного эфира с разной нарезкой на куски — без записи в боевую базу.
//
//   node --env-file=.env specs/008-coarser-sections/research/scripts/simulate-search.mjs
//
// Куски документа эмбедятся локально той же моделью, что в боевом разборе; соперники — разделы других эфиров —
// берутся запросом к боевому индексу (вектор запроса, фильтр `vodId != <эфир>`). Дальше повторяется боевой
// отбор (`Knowledge.search`): 4×topK кусков по оценке, порог, схлопывание в разделы, первые topK.
//
// Нарезка `current` — боевая `chunkSection`; остальные — те же правила с другими границами длины куска
// (min/max/перекрытие). Сверка достоверности: документы прежний, v3 и v4 с боевой нарезкой должны давать
// то же число найденных, что дал боевой поиск (12, 15 и 10 из 20).
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { buildContextLine, chunkSection } from "../../../../src/shared/sections.ts";

const here = (path) => new URL(path, import.meta.url);
const questions = JSON.parse(readFileSync(here("../data/search-questions.json"), "utf8"));
const { streamId } = questions;
const TOP_K = 5;
const MIN_SCORE = 0.65;

const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const MODEL = "openai/text-embedding-3-small";

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const response = await client.embeddings.create({ model: MODEL, input: texts.slice(i, i + 64) });
    out.push(...response.data.map((item) => item.embedding));
  }
  return out;
}

const H = /^## (.+?)\s*\[(\d+):(\d\d):(\d\d)\s*—\s*(\d+):(\d\d):(\d\d)(?:\s*·\s*([^\]]*))?\]\s*$/;
function parseDoc(file) {
  const sections = [];
  let current = null;
  for (const line of readFileSync(here(`../data/${file}`), "utf8").split("\n")) {
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
  for (const s of sections) s.text = s.text.trim();
  return sections;
}

/** Те же правила, что `splitWithOverlap` в `src/shared/sections.ts`, с другими границами длины. */
function chunkWith(text, { min, max, overlap }) {
  if (text.length <= min) return [text];
  const pieces = [];
  let position = 0;
  while (position < text.length) {
    const hardEnd = Math.min(position + max, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const earliest = position + min;
      let boundary = hardEnd;
      for (let i = hardEnd - 1; i > earliest; i -= 1) {
        const ch = text[i];
        if (ch === "\n") { boundary = i + 1; break; }
        if ((ch === "." || ch === "!" || ch === "?") && text[i + 1] === " ") { boundary = i + 2; break; }
      }
      if (boundary > earliest) end = boundary;
    }
    pieces.push(text.slice(position, end).trim());
    if (end >= text.length) break;
    position = Math.max(end - overlap, position + 1);
  }
  return pieces.filter((p) => p.length > 0);
}

const VARIANTS = {
  current: null,
  max1200: { min: 600, max: 1200, overlap: 150 },
  max1000: { min: 500, max: 1000, overlap: 150 },
  max800: { min: 400, max: 800, overlap: 120 },
  max650: { min: 325, max: 650, overlap: 100 },
  max500: { min: 250, max: 500, overlap: 80 },
};

const PUBLISHED_AT = "2026-10-05T19:03:26.000Z";
const DOCS = [
  { label: "прежний (боевой поиск 12)", file: "doc-2892792614-before.md" },
  { label: "v3 (боевой поиск 15)", file: "doc-2892792614-v3.md" },
  { label: "v4 (боевой поиск 10)", file: "doc-2892792614.md" },
];

// Соперники: один раз на вопрос, из боевого индекса, без этого эфира.
const queryVectors = await embed(questions.items.map((q) => q.query));
const rivals = [];
for (const vector of queryVectors) {
  const response = await fetch(`${process.env.UPSTASH_VECTOR_REST_URL}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_VECTOR_REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ vector, topK: 100, includeMetadata: true, filter: `vodId != '${streamId.replace(/'/g, "")}'` }),
  });
  if (!response.ok) throw new Error(`индекс ответил ${response.status}: ${await response.text()}`);
  const { result } = await response.json();
  rivals.push(
    result.map((r) => ({
      key: `${r.metadata.streamId ?? r.metadata.vodId}:${r.metadata.sectionIndex}`,
      score: r.score,
      ours: false,
    })),
  );
}

// Индекс отдаёт оценку, нормированную в 0–1: (1 + косинус) / 2. Проверено на живых данных: свой косинус 0,668
// у раздела с ответом на вопрос 4 дал на боевом поиске оценку 0,834.
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (1 + dot / Math.sqrt(na * nb)) / 2;
};

for (const doc of DOCS) {
  const sections = parseDoc(doc.file);
  console.log(`\n=== ${doc.label}: ${sections.length} разделов ===`);
  for (const [name, params] of Object.entries(VARIANTS)) {
    const chunks = [];
    sections.forEach((section, sectionIndex) => {
      const context = buildContextLine({ publishedAt: PUBLISHED_AT, category: section.category, sectionTitle: section.title });
      const pieces =
        params === null
          ? chunkSection(section, context).map((c) => c.text)
          : chunkWith(section.text, params).map((t) => `${context}\n\n${t}`);
      for (const text of pieces) chunks.push({ sectionIndex, text });
    });
    const vectors = await embed(chunks.map((c) => c.text));

    let found = 0;
    let first = 0;
    const missed = [];
    questions.items.forEach((q, qi) => {
      const own = chunks.map((c, i) => ({
        key: `${streamId}:${c.sectionIndex}`,
        score: cosine(queryVectors[qi], vectors[i]),
        ours: true,
        sectionIndex: c.sectionIndex,
      }));
      if (process.env.DEBUG !== undefined && name === "current") {
        const best = [...own].sort((a, b) => b.score - a.score)[0];
        const rival = [...rivals[qi]].sort((a, b) => b.score - a.score)[0];
        console.log(`  ${q.id} свой ${best?.score.toFixed(3)} (раздел ${best?.sectionIndex}), соперник ${rival?.score.toFixed(3)}, соперников ${rivals[qi].length}`);
      }
      const top = [...rivals[qi], ...own].sort((a, b) => b.score - a.score).slice(0, Math.min(TOP_K * 4, 100));
      const bySection = new Map();
      for (const c of top) {
        if (c.score < MIN_SCORE) continue;
        if (!bySection.has(c.key)) bySection.set(c.key, c);
      }
      const ranked = [...bySection.values()].slice(0, TOP_K);
      const rank = ranked.findIndex(
        (c) => c.ours && sections[c.sectionIndex].startSeconds < q.to && sections[c.sectionIndex].endSeconds > q.from,
      );
      if (rank !== -1) {
        found += 1;
        if (rank === 0) first += 1;
      } else missed.push(q.id);
    });
    console.log(
      `${name.padEnd(8)} кусков ${String(chunks.length).padStart(3)}  найдено ${found} из ${questions.items.length}, первым ${first}; нет: ${missed.join(" ")}`,
    );
  }
}
