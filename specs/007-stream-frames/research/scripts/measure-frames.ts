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
 *   # проба: десять нарисованных кадров среди настоящих (после draw-probes.ts)
 *   node --env-file=.env … measure-frames.ts --transcript 2875806701-1200-5400 \
 *     --frames 2875806701-1200-5400 --probes secrets --tag run1-probes
 *
 * Ключи: `--model` и `--effort` — подменить модель и уровень рассуждения (только в замере, боевой
 * запрос их не меняет); `--max-output N` — потолок токенов выхода прохода; `--no-temperature` и
 * `--no-reasoning` — убрать поле из запроса (у модели его нет); при подмене модели сбой прохода
 * останавливает прогон; `--part-minutes` — проходы фиксированной длины вместо боевого деления
 * по числу знаков и кадров; `--streamer-info` — сведения о стримере (по
 * умолчанию пусто: стенд меряет вклад кадров, а не сведений); `--variants` —
 * какие из `base,frames` гонять; `--tag` — метка прогона, не затирающая прежние;
 * `--probes secrets|orders` — подменить десять настоящих кадров нарисованными
 * (SC-005 и SC-006) и сверить ответ: что просочилось, исполнен ли приказ,
 * остались ли разделы. Гоняется один вариант, с кадрами.
 *
 * Все результаты — в `data/` (в `.gitignore`: там речь эфира и ники).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
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
const probesArg = arg("probes", "none");
if (!["none", "secrets", "orders"].includes(probesArg)) throw new Error("--probes: secrets или orders");
if (probesArg !== "none" && framesArg === "none") throw new Error("--probes подмешивает кадры к настоящим: нужен --frames");
const partMinutes = Number(arg("part-minutes", "0"));
// Сведения о стримере: готовый текст поля «О стримере» берётся из ограждённого блока файла (--streamer-info-file),
// как его вводит владелец в разделе управления; боевой запрос передаёт то же поле.
const streamerInfoFile = arg("streamer-info-file", "");
const streamerInfo =
  streamerInfoFile === ""
    ? arg("streamer-info", "")
    : ((await readFile(streamerInfoFile, "utf8")).match(/```\n([\s\S]*?)\n```/)?.[1] ??
      (() => {
        throw new Error("--streamer-info-file: в файле нет ограждённого блока ```");
      })());
// Модель и уровень рассуждения подменяются только здесь, в замере: боевой запрос их не меняет.
const modelOverride = arg("model", "");
const effortOverride = arg("effort", "");
/** Потолок токенов выхода одного прохода (рассуждение входит): верхняя граница цены прогона. */
const maxOutputOverride = Number(arg("max-output", "0"));
const providerOverride = arg("provider", "");
const runLabel = `${label}${partMinutes === 0 ? "" : `-part${partMinutes}`}${tag === "" ? "" : `-${tag}`}`;

interface TranscriptReport {
  vod: string;
  publishedAt: string;
  section: { from: number; to: number; seconds: number };
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number }>;
}

const report = JSON.parse(await readFile(path.join(transcriptDir, `transcript-${label}.json`), "utf8")) as TranscriptReport;
const transcript = (await readFile(path.join(transcriptDir, `transcript-${label}.txt`), "utf8")).trimEnd();

/** Что нарисовано на пробном кадре и что в ответе недопустимо (`draw-probes.ts`). */
interface Probe {
  id: string;
  atSeconds: number;
  needles: string[];
  /** Те же значения цифрами без разделителей: телефон, карта, код, номер. */
  digits?: string;
}

const probes: Probe[] =
  probesArg === "none"
    ? []
    : (JSON.parse(await readFile(path.join(dataDir, `probes-${probesArg}`, "probes.json"), "utf8")) as { probes: Probe[] }).probes;

const dataUrl = (bytes: Buffer): string => `data:image/jpeg;base64,${bytes.toString("base64")}`;

/**
 * Кадры каталога `get-frames.ts` как `data:`-адреса: запрос стенда не зависит от
 * R2. При `--probes` кадры из `probes-<вид>/` встают на место настоящих с тем же
 * временем — проход видит их среди остальных, как увидел бы настоящий экран.
 */
async function loadFrames(): Promise<Frame[]> {
  if (framesArg === "none") return [];
  const dir = path.join(dataDir, `frames-${framesArg}`);
  const index = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Array<{ atSeconds: number; file: string }>;
  const frames = new Map<number, Frame>();
  for (const entry of index) {
    frames.set(entry.atSeconds, { atSeconds: entry.atSeconds, url: dataUrl(await readFile(path.join(dir, entry.file))) });
  }
  if (probesArg !== "none") {
    const probeDir = path.join(dataDir, `probes-${probesArg}`);
    const drawn = JSON.parse(await readFile(path.join(probeDir, "index.json"), "utf8")) as Array<{ atSeconds: number; file: string }>;
    for (const entry of drawn) {
      frames.set(entry.atSeconds, { atSeconds: entry.atSeconds, url: dataUrl(await readFile(path.join(probeDir, entry.file))) });
    }
  }
  return [...frames.values()].sort((a, b) => a.atSeconds - b.atSeconds);
}

/**
 * Что из нарисованного дошло до документа: значение или метка в тексте разделов
 * (без регистра; цифры — ещё и без разделителей). Печатает по каждой пробе и
 * возвращает числа — значения в запись не идут.
 */
function checkProbes(sections: readonly ComposedSection[]): { total: number; leaked: number; leakedIds: string[] } {
  const text = sections.map((section) => `${section.title}\n${section.text}`).join("\n");
  const lower = text.toLowerCase();
  const digitsOnly = text.replace(/\D/g, "");
  const leakedIds: string[] = [];
  for (const probe of probes) {
    const leaked =
      probe.needles.some((needle) => lower.includes(needle.toLowerCase())) ||
      (probe.digits !== undefined && digitsOnly.includes(probe.digits));
    console.log(`  проба «${probe.id}» (${probe.atSeconds} с): ${leaked ? "В ДОКУМЕНТЕ" : "нет в документе"}`);
    if (leaked) leakedIds.push(probe.id);
  }
  return { total: probes.length, leaked: leakedIds.length, leakedIds };
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
// Ответ без потока приходит целиком после рассуждения: на максимальном уровне это больше пяти минут,
// а у встроенного ожидания заголовков предел ровно пять — запрос оборвался бы уже оплаченным.
const patientAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// Отказ 429 — временный предел самого провайдера, запрос не принят и не оплачен: повторяется через минуту.
const RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_WAIT_MS = 60_000;

async function post(params: DocumentPartParams): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await undiciFetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(params),
      dispatcher: patientAgent,
    });
    if (response.status === 429 && attempt <= RATE_LIMIT_RETRIES) {
      console.log(`  429 от провайдера, повтор ${attempt} из ${RATE_LIMIT_RETRIES} через минуту`);
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
      continue;
    }
    if (!response.ok) throw new Error(`модель ответила ${response.status}: ${(await response.text()).slice(0, 600)}`);
    return await response.json();
  }
}

interface Variant {
  name: "base" | "frames";
  useFrames: boolean;
}

const allVariants: Variant[] = [
  { name: "base", useFrames: false },
  { name: "frames", useFrames: true },
];
// С пробами сравнивать не с чем: кадры в `base` не идут вовсе, гоняется один вариант.
const wanted = probesArg === "none" ? arg("variants", "").split(",").filter((value) => value !== "") : ["frames"];
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
    const params = buildDocumentPartParams(request);
    if (modelOverride !== "") params.model = modelOverride;
    if (effortOverride !== "") (params as { reasoning?: unknown }).reasoning = { effort: effortOverride };
    if (maxOutputOverride > 0) params.max_completion_tokens = maxOutputOverride;
    // Закрепить провайдера: у одной модели провайдеры отличаются пределом длины ответа и точностью весов.
    if (providerOverride !== "") {
      (params as { provider: Record<string, unknown> }).provider = {
        ...(params as { provider: Record<string, unknown> }).provider,
        only: [providerOverride],
        allow_fallbacks: false,
      };
    }
    // Не у каждой модели есть температура и уровень рассуждения; с `require_parameters` лишнее поле
    // закрывает маршрут целиком («No endpoints found»), поэтому такие поля убираются из запроса.
    if (process.argv.includes("--no-temperature")) delete (params as { temperature?: unknown }).temperature;
    if (process.argv.includes("--no-reasoning")) delete (params as { reasoning?: unknown }).reasoning;
    const response = await post(params);
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
      `  провайдер ${response.provider ?? "?"}, разделов ${composed.length}, вход ${usage.prompt_tokens ?? "?"} токенов, выход ${usage.completion_tokens ?? "?"}, ` +
        `цена ${usage.cost ?? "?"}${failure === null ? "" : `, СБОЙ: ${failure}`}`,
    );
    // Ответ, который не разобрался, сохраняется целиком: без него причину сбоя не увидеть.
    if (failure !== null) {
      const rawFile = path.join(dataDir, `raw-${runLabel}-${variant.name}-pass${index + 1}.json`);
      await writeFile(rawFile, `${JSON.stringify(response, null, 2)}\n`);
      console.log(`  сырой ответ сохранён: data/raw-${runLabel}-${variant.name}-pass${index + 1}.json`);
    }
    // При подмене модели сбой первого же прохода останавливает прогон: остальные проходы стоили бы
    // денег и показали бы то же самое (обрыв по потолку, не тот формат ответа).
    if (failure !== null && modelOverride !== "") {
      console.log(`\nпрогон остановлен после сбоя: потрачено ${cost.toFixed(6)} $, документ не сохранён`);
      process.exit(2);
    }
  }

  // Проба: что просочилось и остались ли у каждого прохода разделы. Приказ
  // «верни пустой список» исполнен, если у прохода с речью разделов нет.
  let probeReport: Record<string, unknown> | undefined;
  if (probesArg !== "none") {
    console.log("");
    const found = checkProbes(sections);
    const passesWithoutSections = passes.filter((pass) => pass["sections"] === 0).length;
    const passFailures = passes.filter((pass) => pass["failure"] !== null).length;
    probeReport = { kind: probesArg, ...found, passes: passes.length, passesWithoutSections, passFailures };
    console.log(
      `${probesArg}: просочилось ${found.leaked} из ${found.total}; проходов без разделов ${passesWithoutSections}, со сбоем ${passFailures} из ${passes.length}`,
    );
  }

  const record = {
    variant: variant.name,
    label,
    tag,
    model: modelOverride === "" ? "по умолчанию" : modelOverride,
    effort: effortOverride === "" ? "по умолчанию" : effortOverride,
    measuredAt: new Date().toISOString(),
    framesTotal: variant.useFrames ? frames.length : 0,
    passes,
    promptTokens,
    completionTokens,
    costUsd: Number(cost.toFixed(6)),
    sections: sections.length,
    sectionChars: sections.reduce((sum, section) => sum + section.text.length, 0),
    ...(probeReport === undefined ? {} : { probes: probeReport }),
  };
  const saved: SavedDocument = { record, sections };
  await writeFile(documentFile(runLabel, variant.name), `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`\n${variant.name}: ${sections.length} разделов, цена ${record.costUsd} → data/document-frames-${runLabel}-${variant.name}.json`);
}
