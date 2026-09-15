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
  async composeDocumentPart(request: DocumentPartRequest): Promise<string> {
    try {
      const completion = await this.client.chat.completions.create({
        model: MODELS.document,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        messages: [
          { role: "system", content: DOCUMENT_SYSTEM_PROMPT },
          { role: "user", content: buildDocumentPrompt(request) },
        ],
      });
      const text = completion.choices[0]?.message.content ?? "";
      if (text.trim() === "") {
        throw new AppError("upstream_unavailable", "Модель вернула пустой документ.");
      }
      return text.trim();
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

const DOCUMENT_SYSTEM_PROMPT = `Ты составляешь документ о трансляции по её расшифровке.

Правила:
1. Пиши связный человекочитаемый текст о содержании эфира, а не набор реплик и не список тезисов. Человек должен понять, о чём был стрим, прочитав документ и не открывая запись.
2. Опирайся только на то, что прозвучало в расшифровке. Ничего не додумывай и не добавляй сведений извне.
3. Разбей свой участок на разделы по темам. Каждый раздел начинается строкой заголовка строго такого вида:
   ## Тема раздела [Ч:ММ:СС — Ч:ММ:СС · Категория]
   Время — от начала записи. Категорию бери из списка категорий эфира по времени начала раздела.
4. Раздел должен быть понятен сам по себе, без чтения соседних разделов: называй участников, предметы и обстоятельства, а не «он», «это», «там же».
5. Пропускай участки без внятной речи: музыку, тишину, заглушённые фрагменты. Разделов по ним не создавай.
6. Разделы идут подряд по времени и покрывают весь участок целиком, без пропусков.
7. Размер раздела — от нескольких абзацев; слишком мелкие темы объединяй.
8. Никаких вступлений, заключений и обращений к читателю. Только заголовки разделов и текст под ними.`;

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

/** Расшифровка в виде, пригодном для чтения моделью: время и текст, без служебных полей. */
export function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${Math.round(segment.start)}] ${segment.text}`)
    .join("\n");
}
