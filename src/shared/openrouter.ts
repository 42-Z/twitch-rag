/**
 * Модели: распознавание речи, составление документа и его имени, эмбеддинги.
 *
 * Обращения идут официальным SDK OpenAI — меняется только базовый адрес.
 * OpenRouter совместим с этим интерфейсом во всех видах вызовов, поэтому
 * отдельного клиента писать не нужно. Ключ живёт в секретах Worker и в
 * браузер не попадает.
 */

import OpenAI, { toFile } from "openai";
import { AppError, upstreamError } from "./errors.ts";
import type { TranscriptSegment } from "./time.ts";
import {
  DOCUMENT_NAME_RESPONSE_FORMAT,
  DOCUMENT_RESPONSE_FORMAT,
  documentNameSchema,
  documentSchema,
  type ComposedSection,
} from "./document-schema.ts";
import {
  DOCUMENT_NAME_SYSTEM_PROMPT,
  buildDocumentNameMessage,
  buildDocumentSystemPrompt,
  buildPartMessage,
  buildTranscriptMessage,
} from "./prompt.ts";

export type { ComposedSection };

export const BASE_URL = "https://openrouter.ai/api/v1";

export const MODELS = {
  /** Даёт посегментные таймкоды — без них невозможна ссылка на момент записи. */
  speechToText: "openai/whisper-large-v3-turbo",
  /**
   * Составление документа и выработка имени. Контекст 1 048 576 токенов,
   * потолок выхода 943 718: расшифровка эфира входит целиком, а рассуждения
   * не съедают потолок, как у прежней модели.
   */
  document: "meta/muse-spark-1.3-contributor",
  /** 1536 измерений — столько же у индекса. */
  embedding: "openai/text-embedding-3-small",
} as const;

/**
 * Потолок выхода у выбранной модели — её собственный предел, а не наша
 * оценка. Прежние 32 768 были занижены на порядок: у той модели в них
 * упирались не документ, а её рассуждения, и половина проходов возвращалась
 * пустой. Вход и выход делят один бюджет контекста, поэтому потолок выхода
 * ограничен разницей между контекстом и расшифровкой.
 */
export const MAX_OUTPUT_TOKENS = 943718;

/**
 * Доля потолка, отданная рассуждениям. Значение задаётся явно, а не отдаётся
 * на умолчание каталога: иначе поведение разбора поедет вместе с чужой
 * настройкой. Замеры сделаны на `medium` — оно же умолчание каталога.
 */
const REASONING_EFFORT = "medium";

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
  publishedAt: string;
  categories: ReadonlyArray<{ title: string; startSeconds: number; endSeconds: number }>;
  /** Сведения о стримере от владельца: имена, прозвища и понятия канала (FR-015). */
  streamerInfo?: string;
  /**
   * Ключ закрепления за провайдером. Проходы одной записи обязаны попадать на
   * тот же узел, иначе кэш входа не сработает: закрепление живёт десять минут
   * без обращений и отключается ручным порядком провайдеров, поэтому задаётся
   * ключом сессии, а не полем `provider.order`.
   */
  sessionId: string;
}

/**
 * Поля OpenRouter, которых нет в описании OpenAI. SDK отправляет тело запроса
 * как есть, но проверку типов такой объект не проходит: пересечение с
 * собственным типом описывает их явно, вместо приведения `as any`.
 */
interface OpenRouterExtras {
  reasoning: { effort: string };
  /** Без этого провайдер, не поддержавший схему, молча проигнорирует её. */
  provider: { require_parameters: boolean };
  session_id: string;
}

const openRouterExtras = (sessionId: string): OpenRouterExtras => ({
  reasoning: { effort: REASONING_EFFORT },
  provider: { require_parameters: true },
  session_id: sessionId,
});

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
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & OpenRouterExtras = {
      model: MODELS.document,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      response_format: DOCUMENT_RESPONSE_FORMAT,
      // Порядок сообщений — часть решения, а не оформление: неизменная
      // расшифровка идёт перед меняющейся строкой про участок, иначе общим
      // префиксом проходов остаётся одна системная инструкция, а вся масса
      // текста читается заново по полной цене.
      messages: [
        { role: "system", content: buildDocumentSystemPrompt({ streamerInfo: request.streamerInfo ?? "" }) },
        {
          role: "user",
          content: buildTranscriptMessage({
            publishedAt: request.publishedAt,
            categories: request.categories,
            fullTranscript: request.fullTranscript,
          }),
        },
        { role: "user", content: buildPartMessage(request.part) },
      ],
      ...openRouterExtras(request.sessionId),
    };

    try {
      return readDocumentChoice((await this.client.chat.completions.create(params)).choices?.[0]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw upstreamError("составление документа", error);
    }
  }

  /**
   * Имя документа — отдельным запросом по оглавлению (FR-041).
   *
   * На вход идут заголовки разделов с датой эфира, а не документ целиком:
   * разделов десятки, а для имени хватает их тем. Заголовок трансляции с
   * площадки сюда не попадает вовсе (FR-027).
   */
  async composeDocumentName(input: {
    publishedAt: string;
    sectionTitles: readonly string[];
    sessionId: string;
  }): Promise<string> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & OpenRouterExtras = {
      model: MODELS.document,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      response_format: DOCUMENT_NAME_RESPONSE_FORMAT,
      messages: [
        { role: "system", content: DOCUMENT_NAME_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDocumentNameMessage({
            publishedAt: input.publishedAt,
            sectionTitles: input.sectionTitles,
          }),
        },
      ],
      ...openRouterExtras(input.sessionId),
    };

    try {
      return readDocumentNameChoice((await this.client.chat.completions.create(params)).choices?.[0]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw upstreamError("выработка имени документа", error);
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
 * Ответ модели в том виде, в каком он нужен разбору. Описан структурно, а не
 * типом SDK: так исходы проверяются без сети, а сам разбор не зависит от
 * версии клиента.
 */
export interface CompletionChoice {
  finish_reason?: string | null;
  message?: { refusal?: string | null; content?: string | null } | undefined;
}

/**
 * Разбор ответа по трём исходам, каждому своему.
 *
 * Раньше из ответа брался только `content`, и всё остальное принималось за
 * удачу. Из-за этого отказ модели выглядел невалидным ответом, обрыв по
 * потолку — пустым документом, а ошибка в теле при статусе 200 — успехом.
 */
export function readDocumentChoice(choice: CompletionChoice | undefined): ComposedSection[] {
  const message = requireMessage(choice);
  return parseComposedSections(message.content ?? "");
}

/** Имя документа: тот же разбор исходов, другая схема. */
export function readDocumentNameChoice(choice: CompletionChoice | undefined): string {
  const message = requireMessage(choice);
  const parsed = documentNameSchema.safeParse(parseJson(message.content ?? ""));
  if (!parsed.success) {
    throw new AppError("upstream_unavailable", "Ответ модели об имени документа не соответствует схеме.");
  }
  // Имя уходит в шапку документа и в выдачу, поэтому приводится к одной
  // строке: перенос и хвостовые пробелы там были бы видны.
  const name = parsed.data.name.replace(/\s+/g, " ").trim();
  if (name === "") {
    throw new AppError("upstream_unavailable", "Модель вернула пустое имя документа.");
  }
  return name;
}

/** Общая часть разбора: отказ модели, обрыв по потолку и ответ без вариантов. */
function requireMessage(choice: CompletionChoice | undefined): { refusal?: string | null; content?: string | null } {
  if (choice === undefined) {
    // Ответ 200 с ошибкой в теле приходит без вариантов вовсе, и от успеха
    // его отличает именно это.
    throw new AppError("upstream_unavailable", "Модель ответила без вариантов — обычно это ошибка в теле ответа.");
  }
  const message = choice.message;
  if (message === undefined) {
    throw new AppError("upstream_unavailable", "В ответе модели нет сообщения.");
  }
  // Отказ приходит не ошибкой, а полем `refusal` с остановкой `content_filter`,
  // и в строгую схему он не укладывается: без отдельной проверки он выглядел
  // бы невалидным ответом и уходил бы в бессмысленный повтор.
  if (typeof message.refusal === "string" && message.refusal !== "") {
    throw new AppError("model_refused", `Модель отказалась составлять документ: ${message.refusal}`);
  }
  if (choice.finish_reason === "content_filter") {
    throw new AppError("model_refused", "Модель отказалась составлять документ: сработала модерация.");
  }
  if (choice.finish_reason === "length") {
    throw new AppError("output_truncated", "Ответ модели оборван потолком выхода: он неполон.");
  }
  return message;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("upstream_unavailable", "Модель вернула не JSON.");
  }
}

/**
 * Разбор разделов. Строгая схема обязывает модель, но не заменяет проверку:
 * обрыв по потолку ломает и её, а раздел без времени в документе недопустим
 * (FR-037). Поэтому ответ сверяется со схемой, а негодные разделы отсеиваются
 * здесь, чтобы дальше по конвейеру шло только пригодное.
 */
export function parseComposedSections(raw: string): ComposedSection[] {
  const parsed = documentSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    throw new AppError("upstream_unavailable", "Ответ модели не соответствует схеме документа.");
  }

  // Пустой список — законный ответ для участка, где не звучало речи: там
  // документировать нечего, и инструкция разрешает ответить именно так.
  // Пропуск при этом не остаётся незамеченным: разрыв по времени попадает в
  // реестр причиной (`findCoverageGaps`), а участок без единого раздела при
  // непустой расшифровке виден по нему же.
  const sections: ComposedSection[] = [];
  for (const section of parsed.data.sections) {
    const title = section.title.trim();
    const text = section.text.trim();
    if (title === "" || text === "" || section.endSeconds <= section.startSeconds) continue;
    sections.push({
      title,
      text,
      startSeconds: Math.max(0, section.startSeconds),
      endSeconds: section.endSeconds,
    });
  }

  return sections;
}

/** Расшифровка в виде, пригодном для чтения моделью: время и текст, без служебных полей. */
export function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${Math.round(segment.start)}] ${segment.text}`)
    .join("\n");
}
