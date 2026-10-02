/**
 * Стенд качества кадров (спецификация 007, SC-001…SC-006).
 *
 * Те же проходы составления, что делает разбор, по расшифровке участка записи,
 * подготовленной стендом `002`: без кадров (`base`) и с кадрами (`frames`).
 * Запрос строит боевая `buildDocumentPartParams` — инструкция, схема и
 * умолчания не копируются, поэтому правка раздела «Кадры» в `src/shared/prompt.ts`
 * меняет и замер. От боевого запроса отличается одно: ссылки на кадры заменены
 * данными `data:`, чтобы стенду не нужен был R2.
 *
 * Запуск (всё из корня проекта):
 *
 *   # проходы: без кадров и с кадрами
 *   node --env-file=.env specs/007-stream-frames/research/scripts/measure-frames.ts \
 *     --transcript 2875806701-1200-5400 --frames 2875806701-1200-5400 --tag run1
 *
 *   # только без кадров
 *   node --env-file=.env … measure-frames.ts --transcript 2875806701-1200-5400 --frames none --tag base
 *
 *   # механический счёт контрольных мест по готовым документам прогона
 *   node specs/007-stream-frames/research/scripts/measure-frames.ts \
 *     --check specs/007-stream-frames/research/data/control-places.json --docs 2875806701-1200-5400-run1
 *
 * Ключи: `--part-minutes` — проходы фиксированной длины вместо боевого деления
 * по числу знаков и кадров; `--streamer-info` — сведения о стримере (по
 * умолчанию пусто: стенд меряет вклад кадров, а не сведений); `--variants` —
 * какие из `base,frames` гонять; `--tag` — метка прогона, не затирающая прежние.
 *
 * Все результаты — в `data/` (в `.gitignore`: там речь эфира и ники).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { planDocumentParts } from "../../../../src/shared/categories.ts";
import { framesInRange, minPassesForFrames, type Frame } from "../../../../src/shared/frames.ts";
import {
  BASE_URL,
  buildDocumentPartParams,
  readDocumentChoice,
  type ComposedSection,
  type DocumentPartParams,
  type DocumentPartRequest,
} from "../../../../src/shared/openrouter.ts";

/**
 * Знаков расшифровки на проход — как `CHARS_PER_PART` в `src/worker/workflow.ts`
 * (модуль разбора под Node не подключается, поэтому значение повторено здесь;
 * поменялось там — поменять и тут).
 */
const CHARS_PER_PART = 30000;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`нужен --${name}`);
  }
  return value;
}

const researchDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(researchDir, "data");
const transcriptDir = arg("transcript-dir", path.resolve(researchDir, "../../002-document-quality/research/data"));

/** Раздел так, как его сохраняет стенд: общий для режимов «проходы» и «счёт». */
interface SavedDocument {
  record: Record<string, unknown>;
  sections: ComposedSection[];
}

const documentFile = (runLabel: string, variant: string): string =>
  path.join(dataDir, `document-frames-${runLabel}-${variant}.json`);

// ---------------------------------------------------------------------------
// Режим «счёт»: сколько контрольных мест документ закрыл.
// ---------------------------------------------------------------------------

/** Контрольное место: момент эфира и допустимые написания ожидаемого названия. */
interface ControlPlace {
  id: string;
  /** `subject` — предмет, на который указывает речь (SC-001); `name` — верное написание имени (SC-002). */
  kind: "subject" | "name";
  atSeconds: number;
  /** Что сказано — для человека, в счёте не участвует. */
  spoken?: string;
  /** Допустимые написания: достаточно любого. */
  accept: string[];
}

/** Сравнение без регистра и без различия «е»/«ё»: проверяется название, а не оформление. */
const normalize = (text: string): string =>
  text.toLowerCase().replaceAll("ё", "е").replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();

/** Раздел относится к месту, если его время лежит не дальше `margin` секунд от момента. */
function sectionsAround(sections: readonly ComposedSection[], atSeconds: number, margin: number): ComposedSection[] {
  return sections.filter((section) => section.startSeconds <= atSeconds + margin && section.endSeconds >= atSeconds - margin);
}

async function runCheck(): Promise<void> {
  const placesFile = arg("check");
  const docs = arg("docs");
  const margin = Number(arg("margin", "90"));
  const { places } = JSON.parse(await readFile(placesFile, "utf8")) as { places: ControlPlace[] };

  for (const variant of ["base", "frames"]) {
    let saved: SavedDocument;
    try {
      saved = JSON.parse(await readFile(documentFile(docs, variant), "utf8")) as SavedDocument;
    } catch {
      continue;
    }
    console.log(`\n${variant}: ${saved.sections.length} разделов`);
    const found: Record<string, { hit: number; total: number }> = {};
    for (const place of places) {
      const text = normalize(sectionsAround(saved.sections, place.atSeconds, margin).map((section) => `${section.title} ${section.text}`).join(" "));
      const hit = place.accept.some((variantName) => text.includes(normalize(variantName)));
      const counter = (found[place.kind] ??= { hit: 0, total: 0 });
      counter.total += 1;
      if (hit) counter.hit += 1;
      console.log(`  ${hit ? "есть " : "нет  "} ${place.id} (${place.kind}, ${place.atSeconds} с): ${place.accept[0] ?? ""}`);
    }
    for (const [kind, counter] of Object.entries(found)) {
      console.log(`  ИТОГО ${kind}: ${counter.hit} из ${counter.total}`);
    }
  }
}

if (process.argv.includes("--check")) {
  await runCheck();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Режим «проходы»: запросы к модели.
// ---------------------------------------------------------------------------

const key = process.env["OPENROUTER_API_KEY"] ?? "";
if (key === "") throw new Error("нет OPENROUTER_API_KEY");

const label = arg("transcript");
const framesArg = arg("frames", "none");
const tag = arg("tag", "");
const partMinutes = Number(arg("part-minutes", "0"));
const streamerInfo = arg("streamer-info", "");
const runLabel = `${label}${partMinutes === 0 ? "" : `-part${partMinutes}`}${tag === "" ? "" : `-${tag}`}`;

interface TranscriptReport {
  vod: string;
  publishedAt: string;
  section: { from: number; to: number; seconds: number };
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number }>;
}

const report = JSON.parse(await readFile(path.join(transcriptDir, `transcript-${label}.json`), "utf8")) as TranscriptReport;
const transcript = (await readFile(path.join(transcriptDir, `transcript-${label}.txt`), "utf8")).trimEnd();

/** Кадры каталога `get-frames.ts` как `data:`-адреса: запрос стенда не зависит от R2. */
async function loadFrames(): Promise<Frame[]> {
  if (framesArg === "none") return [];
  const dir = path.join(dataDir, `frames-${framesArg}`);
  const index = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Array<{ atSeconds: number; file: string }>;
  const frames: Frame[] = [];
  for (const entry of index) {
    const bytes = await readFile(path.join(dir, entry.file));
    frames.push({ atSeconds: entry.atSeconds, url: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  }
  return frames;
}

const frames = await loadFrames();
const range = { startSeconds: report.section.from, endSeconds: report.section.to };
// Число проходов — как в разборе: по знакам и по кадрам. Одно и то же деление
// у обоих вариантов, иначе сравнивались бы разные участки.
const passCount =
  partMinutes > 0
    ? Math.ceil((range.endSeconds - range.startSeconds) / (partMinutes * 60))
    : Math.max(1, Math.ceil(transcript.length / CHARS_PER_PART), minPassesForFrames(frames.length));
const parts = planDocumentParts(range, report.chapters, passCount);
console.log(`расшифровка: ${transcript.length} знаков; кадров: ${frames.length}; проходов: ${parts.length}`);

/** Один запрос к модели: тело — боевые параметры как есть. */
async function post(params: DocumentPartParams): Promise<any> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(`модель ответила ${response.status}: ${(await response.text()).slice(0, 600)}`);
  return await response.json();
}

interface Variant {
  name: "base" | "frames";
  useFrames: boolean;
}

const allVariants: Variant[] = [
  { name: "base", useFrames: false },
  { name: "frames", useFrames: true },
];
const wanted = arg("variants", "").split(",").filter((value) => value !== "");
const chosen = allVariants
  .filter((variant) => (variant.useFrames ? frames.length > 0 : true))
  .filter((variant) => wanted.length === 0 || wanted.includes(variant.name));
if (chosen.length === 0) throw new Error("нечего гонять: для варианта frames нужны кадры (--frames <каталог>)");

for (const variant of chosen) {
  const sections: ComposedSection[] = [];
  const passes: Array<Record<string, unknown>> = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cost = 0;

  for (const [index, part] of parts.entries()) {
    const request: DocumentPartRequest = {
      fullTranscript: transcript,
      part,
      publishedAt: report.publishedAt,
      categories: report.chapters,
      streamerInfo,
      sessionId: `stand-${runLabel}`,
      frames: variant.useFrames ? framesInRange(frames, part) : [],
    };
    console.log(`\n${variant.name}, проход ${index + 1} из ${parts.length} (${part.startSeconds}–${part.endSeconds} с, кадров ${request.frames?.length ?? 0})…`);

    const started = Date.now();
    const response = await post(buildDocumentPartParams(request));
    const usage = response.usage ?? {};
    let composed: ComposedSection[] = [];
    let failure: string | null = null;
    try {
      composed = readDocumentChoice(response.choices?.[0]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    sections.push(...composed);
    promptTokens += usage.prompt_tokens ?? 0;
    completionTokens += usage.completion_tokens ?? 0;
    cost += usage.cost ?? 0;
    passes.push({
      part,
      frames: request.frames?.length ?? 0,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      costUsd: usage.cost ?? null,
      finishReason: response.choices?.[0]?.finish_reason ?? null,
      provider: response.provider ?? null,
      sections: composed.length,
      failure,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    console.log(
      `  разделов ${composed.length}, вход ${usage.prompt_tokens ?? "?"} токенов, выход ${usage.completion_tokens ?? "?"}, ` +
        `цена ${usage.cost ?? "?"}${failure === null ? "" : `, СБОЙ: ${failure}`}`,
    );
  }

  const record = {
    variant: variant.name,
    label,
    tag,
    measuredAt: new Date().toISOString(),
    framesTotal: variant.useFrames ? frames.length : 0,
    passes,
    promptTokens,
    completionTokens,
    costUsd: Number(cost.toFixed(6)),
    sections: sections.length,
    sectionChars: sections.reduce((sum, section) => sum + section.text.length, 0),
  };
  const saved: SavedDocument = { record, sections };
  await writeFile(documentFile(runLabel, variant.name), `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`\n${variant.name}: ${sections.length} разделов, цена ${record.costUsd} → data/document-frames-${runLabel}-${variant.name}.json`);
}
