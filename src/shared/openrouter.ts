/**
 * Модели: распознавание речи, составление документа, эмбеддинги.
 *
 * Обращения идут официальным SDK OpenAI — меняется только базовый адрес.
 * OpenRouter совместим с этим интерфейсом во всех трёх видах вызовов, поэтому
 * отдельного клиента писать не нужно. Ключ живёт в секретах Worker и в
 * браузер не попадает.
 */

import OpenAI, { toFile } from "openai";
import { upstreamError, AppError } from "./errors.ts";
import type { TranscriptSegment } from "./time.ts";

export const BASE_URL = "https://openrouter.ai/api/v1";

export const MODELS = {
  /** Даёт посегментные таймкоды — без них невозможна ссылка на момент записи. */
  speechToText: "openai/whisper-large-v3-turbo",
  /** Контекст в 262 тысячи токенов: расшифровка эфира входит целиком. */
  document: "inclusionai/ling-3.0-flash",
  /** 1536 измерений — столько же у индекса. */
  embedding: "openai/text-embedding-3-small",
} as const;

/** Выход модели ограничен, поэтому документ пишется в несколько проходов. */
export const MAX_OUTPUT_TOKENS = 32768;

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  language: string;
  durationSeconds: number;
}

export interface DocumentPartRequest {
  /** Полная расшифровка эфира: модель обязана видеть его целиком. */
  fullTranscript: string;
  /** Участок, который пишется в этом проходе. */
  part: { startSeconds: number; endSeconds: number };
  streamTitle: string;
  publishedAt: string;
  categories: ReadonlyArray<{ title: string; startSeconds: number; endSeconds: number }>;
}

export class OpenRouter {
  private readonly client: OpenAI;

  constructor(private readonly apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: BASE_URL });
  }

  /**
   * Распознавание одного куска аудио.
   *
   * Куски по десять минут не от хорошей жизни: у провайдера 60 секунд на
   * запрос, а часовой кусок по замеренной скорости в этот срок не уложится.
   * Цена от дробления не растёт — тарифицируется длительность аудио.
   */
  async transcribe(
    audio: ArrayBuffer,
    options: { filename: string; language?: string },
  ): Promise<TranscriptionResult> {
    try {
      const file = await toFile(audio, options.filename, { type: "audio/mp4" });
      const response = await this.client.audio.transcriptions.create({
        file,
        model: MODELS.speechToText,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(options.language === undefined ? {} : { language: options.language }),
      });

      const segments = (response.segments ?? []).map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text.trim(),
      }));

      return {
        segments: segments.filter((segment) => segment.text !== ""),
        language: response.language,
        durationSeconds: response.duration,
      };
    } catch (error) {
      throw upstreamError("распознавание речи", error);
    }
  }

  /**
   * Один проход составления документа.
   *
   * Модель получает расшифровку целиком, но пишет только свой участок:
   * отсылки внутри эфира теряют смысл, если видеть его кусками, а выход
   * модели не вмещает пересказ семи часов за раз.
   */
  async composeDocumentPart(request: DocumentPartRequest): Promise<ComposedSection[]> {
    try {
      const completion = await this.client.chat.completions.create({
        model: MODELS.document,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DOCUMENT_SYSTEM_PROMPT },
          { role: "user", content: buildDocumentPrompt(request) },
        ],
      });
      const text = completion.choices[0]?.message.content ?? "";
      if (text.trim() === "") {
        throw new AppError("upstream_unavailable", "Модель вернула пустой документ.");
      }
      return parseComposedSections(text);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw upstreamError("составление документа", error);
    }
  }

  /** Эмбеддинги кусков и поисковых запросов — одна и та же модель по обе стороны. */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const response = await this.client.embeddings.create({
        model: MODELS.embedding,
        input: [...texts],
      });
      return response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding as number[]);
    } catch (error) {
      throw upstreamError("эмбеддинги", error);
    }
  }

  /**
   * Проверка ключа без расхода: OpenRouter отдаёт сведения о ключе отдельной
   * точкой, тратить на это запрос к модели незачем.
   */
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${BASE_URL}/key`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Ответ просится в JSON, а не размеченным текстом, потому что время раздела —
 * число, и договориться о его записи словами не вышло: одна и та же модель на
 * трёх прогонах выдала `0:47:55`, `0:165` и голые секунды, и каждый раз разбор
 * терял вместе с непонятым заголовком часы эфира. В JSON число приходит числом.
 */
const DOCUMENT_SYSTEM_PROMPT = `Ты составляешь документ о трансляции по её расшифровке.

Ответ — только JSON такого вида, без markdown и пояснений вокруг:
{"sections": [{"title": "Спор о правилах сервера", "startSeconds": 4040, "endSeconds": 4745, "text": "Текст раздела в несколько абзацев."}]}

Правила:
1. Пиши по-русски — и названия разделов, и текст. Расшифровка может прийти на любом языке: распознавание ошибается с языком на музыке и шуме и выдаёт куски эфира по-английски. Язык расшифровки на язык документа не влияет.
2. Пиши связный человекочитаемый текст о содержании эфира, а не набор реплик и не список тезисов. Человек должен понять, о чём был стрим, прочитав документ и не открывая запись.
3. Опирайся только на то, что прозвучало в расшифровке. Ничего не додумывай и не добавляй сведений извне.
4. Разбей свой участок на разделы по темам. Поле title — собственное название темы в несколько слов, по тому, что в разделе происходит. Поля startSeconds и endSeconds — целые числа секунд от начала записи.
5. Раздел должен быть понятен сам по себе, без чтения соседних разделов: называй участников, предметы и обстоятельства, а не «он», «это», «там же».
6. Пропускай участки без внятной речи: музыку, тишину, заглушённые фрагменты. Разделов по ним не создавай.
7. Разделы идут подряд по времени и покрывают весь участок целиком, без пропусков.
8. Размер раздела — от нескольких абзацев; слишком мелкие темы объединяй.
9. Никаких вступлений, заключений и обращений к читателю: в поле text только содержание раздела.`;

function buildDocumentPrompt(request: DocumentPartRequest): string {
  const categories = request.categories
    .map((category) => `- ${category.title}: ${category.startSeconds}–${category.endSeconds} с`)
    .join("\n");

  return `Трансляция: «${request.streamTitle}»
Дата эфира: ${request.publishedAt.slice(0, 10)}

Категории эфира по времени:
${categories === "" ? "- категории не указаны" : categories}

Твой участок: с ${request.part.startSeconds} по ${request.part.endSeconds} секунду записи.
Пиши разделы только про этот участок. Остальная расшифровка дана, чтобы ты понимал отсылки и не пересказывал одно и то же дважды.

Расшифровка эфира целиком (время в секундах от начала записи):

${request.fullTranscript}`;
}

/** Раздел, каким его вернула модель: категория проставляется позже, по времени. */
export interface ComposedSection {
  title: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Разбор ответа модели. Режим JSON гарантирует синтаксис, но не содержимое:
 * раздел без текста или с временем задом наперёд отбрасывается здесь, чтобы
 * дальше по конвейеру шло только пригодное.
 */
export function parseComposedSections(raw: string): ComposedSection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("upstream_unavailable", "Модель вернула не JSON.");
  }

  const list = (parsed as { sections?: unknown }).sections;
  if (!Array.isArray(list)) {
    throw new AppError("upstream_unavailable", "В ответе модели нет разделов.");
  }

  const sections: ComposedSection[] = [];
  for (const item of list) {
    const section = item as Record<string, unknown>;
    const title = typeof section["title"] === "string" ? section["title"].trim() : "";
    const text = typeof section["text"] === "string" ? section["text"].trim() : "";
    const start = Math.round(Number(section["startSeconds"]));
    const end = Math.round(Number(section["endSeconds"]));
    if (title === "" || text === "" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }
    sections.push({ title, startSeconds: Math.max(0, start), endSeconds: end, text });
  }

  if (sections.length === 0) {
    throw new AppError("upstream_unavailable", "Модель не дала ни одного пригодного раздела.");
  }
  return sections;
}

/** Расшифровка в виде, пригодном для чтения моделью: время и текст, без служебных полей. */
export function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${Math.round(segment.start)}] ${segment.text}`)
    .join("\n");
}
