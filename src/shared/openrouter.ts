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
  buildPartContent,
  buildTranscriptMessage,
} from "./prompt.ts";
import type { Frame } from "./frames.ts";

export type { ComposedSection };

export const BASE_URL = "https://openrouter.ai/api/v1";

export const MODELS = {
  /** Даёт посегментные таймкоды — без них невозможна ссылка на момент записи. */
  speechToText: "openai/whisper-large-v3-turbo",
  /**
   * Составление документа и выработка имени. Контекст 1 050 000 токенов,
   * потолок выхода 128 000: расшифровка эфира входит целиком. Выбор владельца
   * (спецификация 007, допущения): на замерах у неё меньше ошибок на раздел и
   * выдумок, чем у `meta/muse-spark-1.3-contributor`; цена выше, расчёт — в
   * `specs/007-stream-frames/baseline.md` §6.
   */
  document: "openai/gpt-6-luna",
  /** 1536 измерений — столько же у индекса. */
  embedding: "openai/text-embedding-3-small",
} as const;

/**
 * Потолок выхода у выбранной модели — её собственный предел по каталогу
 * (`top_provider.max_completion_tokens`), а не наша оценка. Рассуждения на
 * `max` входят в него: самый длинный выход на замерах — 82 190 токенов
 * (64 %), и ответ, упёршийся в потолок, приходит пустым, но оплаченным.
 */
export const MAX_OUTPUT_TOKENS = 128000;

/**
 * Уровень рассуждений. Значение задаётся явно, а не отдаётся на умолчание
 * каталога: иначе поведение разбора поедет вместе с чужой настройкой. Все
 * замеры качества сделаны на `max`; на запросе имени он стоит $0,000447.
 */
const REASONING_EFFORT = "max";

/**
 * Сколько ждать ответа на проход составления. По умолчанию у клиента SDK
 * десять минут, а самый долгий проход на замерах занял 558 с
 * (`specs/007-stream-frames/baseline.md` §6): с запасом вдвое. Шаг Workflow
 * ждёт дольше клиента, чтобы обрыв приходил ошибкой клиента, а не снятием шага.
 */
export const DOCUMENT_REQUEST_TIMEOUT_MINUTES = 20;
export const DOCUMENT_STEP_TIMEOUT_MINUTES = 30;

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
  /**
   * Кадры этого участка по возрастанию времени: картинки по ссылкам, которые
   * скачивает провайдер. Нет — запрос такой же, как до кадров, байт в байт
   * (инструкция без раздела «Кадры», сообщение об участке строкой).
   */
  frames?: readonly Frame[];
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

export type DocumentPartParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & OpenRouterExtras;

/**
 * Параметры запроса прохода — чистая сборка, без обращения к сети. Вынесена
 * из адаптера, чтобы стенд качества мерил боевой запрос, а не его копию: стенд
 * подменяет лишь ссылки на кадры данными `data:`.
 *
 * Порядок сообщений — часть решения, а не оформление: неизменная расшифровка
 * идёт перед меняющимся сообщением об участке, иначе общим префиксом проходов
 * остаётся одна системная инструкция, а вся масса текста читается заново по
 * полной цене. Кадры лежат в последнем сообщении и в префикс не входят.
 */
export function buildDocumentPartParams(request: DocumentPartRequest): DocumentPartParams {
  const frames = request.frames ?? [];
  return {
    model: MODELS.document,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: DOCUMENT_RESPONSE_FORMAT,
    messages: [
      {
        role: "system",
        content: buildDocumentSystemPrompt({ streamerInfo: request.streamerInfo ?? "", withFrames: frames.length > 0 }),
      },
      {
        role: "user",
        content: buildTranscriptMessage({
          publishedAt: request.publishedAt,
          categories: request.categories,
          fullTranscript: request.fullTranscript,
        }),
      },
      { role: "user", content: buildPartContent(request.part, frames, request.fullTranscript) },
    ],
    ...openRouterExtras(request.sessionId),
  };
}

/** Параметры запроса имени документа — чистая сборка, как у `buildDocumentPartParams`. */
export function buildDocumentNameParams(input: {
  publishedAt: string;
  sectionTitles: readonly string[];
  sessionId: string;
}): DocumentPartParams {
  return {
    model: MODELS.document,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
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
}

export class OpenRouter {
  private readonly client: OpenAI;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
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
    const params = buildDocumentPartParams(request);

    try {
      // Повторов клиента нет: он повторяет и оборванный по таймауту запрос, три раза по двадцать минут
      // не уложились бы в тридцать минут шага, а каждый повтор на `max` оплачивается заново. Отказы
      // 429 и 5xx повторяет сам шаг Workflow.
      const response = await this.client.chat.completions.create(params, {
        timeout: DOCUMENT_REQUEST_TIMEOUT_MINUTES * 60_000,
        maxRetries: 0,
      });
      return readDocumentChoice(response.choices?.[0]);
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
    const params = buildDocumentNameParams(input);

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

/**
 * Статусы, при которых виноваты не кадры: ключ, деньги, срок ответа, частота.
 * Повтор без кадров их не лечит.
 */
const NOT_FRAMES_STATUSES = new Set([401, 402, 408, 429]);

/**
 * Отказала ли модель из-за кадров: запрос с кадрами закончился отказом модели
 * (`model_refused`) либо ответом 4xx, кроме 401, 402, 408 и 429.
 *
 * Разбор по классу ответа, а не по типу ошибки: документированные типы
 * (`image_download_failed`, `invalid_image`…) живые ответы OpenRouter не несут —
 * там `400 Provider returned error` с кодом провайдера, а для мусорной картинки
 * и вовсе без кода (`research.md` §6). Если причина была не в кадрах (скажем,
 * превышен контекст), повтор без них упадёт так же, и ошибка уйдёт наверх как
 * раньше: цена ошибки в классификации — одно лишнее обращение.
 *
 * Статус берётся у причины, а не у самой ошибки: у `AppError` свой `status` —
 * он зависит от кода (`invalid_input` — 400) и о ответе модели ничего не говорит.
 * Обрыв соединения, 5xx и 408 SDK повторяет сам, до этого места они не доходят.
 */
export function isFramesRejection(error: unknown): boolean {
  if (error instanceof AppError && error.code === "model_refused") return true;

  const source: unknown = error instanceof AppError ? error.cause : error;
  const status = typeof source === "object" && source !== null ? (source as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && !NOT_FRAMES_STATUSES.has(status);
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
  if ((choice.finish_reason as string) === "error") {
    // OpenRouter: провайдер упал после начала ответа — статус 200, а причина в `finish_reason`.
    throw new AppError("upstream_unavailable", "Провайдер модели оборвал ответ ошибкой.");
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
    // Обрезка идёт до проверки, а не после: схема допускает любое целое, и
    // раздел с отрицательным концом проходил проверку по исходным значениям,
    // а после обрезки начала нулём получался раздел, у которого начало
    // больше конца, — ровно то, что проверка и запрещает.
    const startSeconds = Math.max(0, section.startSeconds);
    const endSeconds = Math.max(0, section.endSeconds);
    if (title === "" || text === "" || endSeconds <= startSeconds) continue;
    sections.push({ title, text, startSeconds, endSeconds });
  }

  return sections;
}

/** Расшифровка в виде, пригодном для чтения моделью: время и текст, без служебных полей. */
export function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${Math.round(segment.start)}] ${segment.text}`)
    .join("\n");
}
