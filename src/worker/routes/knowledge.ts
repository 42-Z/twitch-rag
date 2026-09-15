/**
 * Знания для программных клиентов: главный контракт продукта.
 *
 * Доступ публичный и без авторизации — ради этого сервис и существует.
 * Ограничение частоты и потолки на размер запроса здесь не формальность,
 * а условие, при котором публичность не разоряет владельца.
 */

import { z } from "zod";
import { AppError } from "../../shared/errors.ts";
import type { Services } from "../env.ts";
import type { FoundSection } from "../../shared/knowledge.ts";
import { MAX_QUERY_CHARS } from "../ratelimit.ts";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  topK: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.string().trim().max(200).optional(),
});

export interface SearchRequest {
  query: string;
  topK: number;
  minScore: number;
  fromUnix?: number;
  toUnix?: number;
  category?: string;
}

/** Ответ на запрос знаний в форме контракта — одинаковый для HTTP и для MCP. */
export interface SearchResponse {
  found: boolean;
  documents: FoundSection[];
  message?: string;
  stats?: { returned: number; latencyMs: number };
}

export const NO_KNOWLEDGE_MESSAGE = "В базе знаний нет сведений по этому вопросу.";

/**
 * Разбор и проверка входа. Отдельно от обработки, потому что тем же входом
 * пользуется MCP-сервер: расхождение между двумя путями — дефект.
 */
export function parseSearchRequest(input: unknown): SearchRequest {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("invalid_input", describeIssue(issue));
  }
  const value = parsed.data;

  const fromUnix = value.from === undefined ? undefined : dateToUnix(value.from, "начала");
  const toUnix = value.to === undefined ? undefined : dateToUnix(value.to, "конца") + 86399;
  if (fromUnix !== undefined && toUnix !== undefined && fromUnix > toUnix) {
    throw new AppError("invalid_input", "Начало диапазона дат позже его конца.");
  }

  return {
    query: value.query,
    topK: value.topK ?? 5,
    minScore: value.minScore ?? 0.35,
    ...(fromUnix === undefined ? {} : { fromUnix }),
    ...(toUnix === undefined ? {} : { toUnix }),
    ...(value.category === undefined || value.category === "" ? {} : { category: value.category }),
  };
}

/**
 * Поиск знаний. Запрос обслуживается по готовым знаниям независимо от того,
 * идёт ли в этот момент разбор новой трансляции: разбор живёт в отдельном
 * процессе и на выдачу не влияет.
 */
export async function searchKnowledge(
  request: SearchRequest,
  services: Services,
): Promise<SearchResponse> {
  const startedAt = Date.now();

  const [vector] = await services.models.embed([request.query]);
  if (vector === undefined) {
    throw new AppError("upstream_unavailable", "Не удалось построить вектор запроса.");
  }

  const documents = await services.knowledge.search(vector, {
    topK: request.topK,
    minScore: request.minScore,
    ...(request.fromUnix === undefined ? {} : { fromUnix: request.fromUnix }),
    ...(request.toUnix === undefined ? {} : { toUnix: request.toUnix }),
    ...(request.category === undefined ? {} : { category: request.category }),
  });

  // Отсутствие знаний — обычный ответ, а не ошибка: ассистент должен сказать
  // «сведений нет», а не получить отказ и додумать своё.
  if (documents.length === 0) {
    return { found: false, documents: [], message: NO_KNOWLEDGE_MESSAGE };
  }

  return {
    found: true,
    documents,
    stats: { returned: documents.length, latencyMs: Date.now() - startedAt },
  };
}

export interface KnowledgeStats {
  channel: string | null;
  streams: { ready: number; skipped: number };
  sections: number;
  coverage: { from: string | null; to: string | null };
  categories: string[];
  lastIndexedAt: string | null;
}

/** Границы базы знаний: нужны ассистенту, чтобы честно говорить о пределах своих сведений. */
export async function knowledgeStats(services: Services): Promise<KnowledgeStats> {
  const [channel, streams] = await Promise.all([
    services.registry.getChannel(),
    services.registry.listStreams(),
  ]);

  const ready = streams.filter((stream) => stream.status === "ready");
  const skipped = streams.filter((stream) => stream.status === "skipped");

  const categories = new Set<string>();
  let sections = 0;
  let lastIndexedAt = 0;
  for (const stream of ready) {
    sections += stream.sectionCount ?? 0;
    for (const chapter of stream.categories) categories.add(chapter.title);
    if ((stream.processedAt ?? 0) > lastIndexedAt) lastIndexedAt = stream.processedAt ?? 0;
  }

  const dates = ready.map((stream) => stream.publishedAtUnix).sort((a, b) => a - b);

  return {
    channel: channel?.login ?? null,
    streams: { ready: ready.length, skipped: skipped.length },
    sections,
    coverage: {
      from: dates.length > 0 ? toIso(dates[0] as number) : null,
      to: dates.length > 0 ? toIso(dates[dates.length - 1] as number) : null,
    },
    categories: [...categories].filter((title) => title !== ""),
    lastIndexedAt: lastIndexedAt > 0 ? toIso(lastIndexedAt) : null,
  };
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function dateToUnix(date: string, edge: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new AppError("invalid_input", `Неверная дата ${edge} диапазона: ожидается ГГГГ-ММ-ДД.`);
  }
  return Math.floor(parsed / 1000);
}

function describeIssue(issue: { path: PropertyKey[]; message: string } | undefined): string {
  const field = issue?.path.join(".") ?? "";
  if (field === "query") return `Вопрос должен быть от 1 до ${MAX_QUERY_CHARS} знаков.`;
  if (field === "topK") return "Число результатов — целое от 1 до 20.";
  if (field === "minScore") return "Порог близости — число от 0 до 1.";
  if (field === "from" || field === "to") return "Границы дат задаются как ГГГГ-ММ-ДД.";
  return "Запрос составлен неверно.";
}
