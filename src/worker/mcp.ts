/**
 * MCP-сервер: прямой способ для ИИ-ассистента пользоваться базой.
 *
 * Своей логики поиска здесь нет — вызывается тот же сервис, что и
 * `POST /api/knowledge/search`. Расхождение ответов между двумя путями было
 * бы дефектом, поэтому общий код один на оба.
 *
 * Транспорт — Streamable HTTP без состояния: поиск не помнит предыдущих
 * вопросов, поэтому Durable Objects не нужны. Авторизации нет — так задумано
 * (FR-027).
 */

import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATE_PATTERN } from "./routes/knowledge.ts";
import type { Env } from "./env.ts";
import { createServices } from "./env.ts";
import { formatClock } from "../shared/time.ts";
import { documentName } from "../shared/document-name.ts";
import {
  dateToUnix,
  knowledgeStats,
  parseSearchRequest,
  searchKnowledge,
  NO_KNOWLEDGE_MESSAGE,
} from "./routes/knowledge.ts";

const SERVER_NAME = "twitch-knowledge";
const SERVER_VERSION = "0.1.0";

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const services = createServices(env);

  server.registerTool(
    "search_knowledge",
    {
      description:
        "Найти, что говорилось на стримах канала. Возвращает разделы пересказов с темой, датой эфира, категорией и ссылкой на момент записи. Использовать, когда вопрос касается мнений, решений, планов или событий, обсуждавшихся на стримах.",
      inputSchema: {
        query: z.string().describe("Вопрос или тема обычными словами"),
        topK: z.number().int().min(1).max(20).optional().describe("Сколько разделов вернуть, по умолчанию 5"),
        from: z.string().regex(DATE_PATTERN, "Ожидается дата вида ГГГГ-ММ-ДД").optional().describe("Не раньше этой даты эфира, ГГГГ-ММ-ДД"),
        to: z.string().regex(DATE_PATTERN, "Ожидается дата вида ГГГГ-ММ-ДД").optional().describe("Не позже этой даты эфира, ГГГГ-ММ-ДД"),
        category: z.string().optional().describe("Ограничить категорией трансляции"),
      },
    },
    async (input) => {
      const request = parseSearchRequest(input);
      const result = await searchKnowledge(request, services);

      if (!result.found) {
        // Не ошибка: модель должна сказать, что сведений нет, а не додумать.
        return { content: [{ type: "text" as const, text: NO_KNOWLEDGE_MESSAGE }] };
      }

      const blocks = result.documents.map((document, index) => {
        const date = document.stream.publishedAt.slice(0, 10);
        const category = document.category === "" ? "" : `, ${document.category}`;
        const at = formatClock(document.startSeconds);
        return [
          `[${index + 1}] ${document.topic}`,
          `    «${document.stream.title}», ${date}${category}, ${at}`,
          `    ${document.stream.url}`,
          "",
          document.text,
        ].join("\n");
      });

      return {
        content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        structuredContent: { found: true, documents: result.documents },
      };
    },
  );

  server.registerTool(
    "knowledge_stats",
    {
      description:
        "Узнать границы базы знаний: какой канал, сколько трансляций разобрано, за какой период и какие категории встречаются. Использовать, чтобы честно ответить, есть ли сведения о нужном периоде.",
      inputSchema: {},
    },
    async () => {
      const stats = await knowledgeStats(services);
      const period =
        stats.coverage.from === null
          ? "трансляций пока нет"
          : `с ${stats.coverage.from.slice(0, 10)} по ${(stats.coverage.to ?? "").slice(0, 10)}`;
      const text = [
        `Канал: ${stats.channel ?? "не указан"}`,
        `Разобрано трансляций: ${stats.streams.ready}, пропущено: ${stats.streams.skipped}`,
        `Разделов в базе: ${stats.sections}`,
        `Период: ${period}`,
        `Категории: ${stats.categories.join(", ") || "нет"}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], structuredContent: { ...stats } };
    },
  );

  server.registerTool(
    "list_streams",
    {
      description:
        "Перечислить разобранные трансляции с именами документов, датами и категориями. Имя документа выработано по содержанию эфира. Использовать, когда вопрос касается конкретного эфира или периода, а не темы.",
      inputSchema: {
        from: z.string().regex(DATE_PATTERN, "Ожидается дата вида ГГГГ-ММ-ДД").optional().describe("Не раньше этой даты эфира, ГГГГ-ММ-ДД"),
        to: z.string().regex(DATE_PATTERN, "Ожидается дата вида ГГГГ-ММ-ДД").optional().describe("Не позже этой даты эфира, ГГГГ-ММ-ДД"),
        limit: z.number().int().min(1).max(50).optional().describe("Сколько трансляций вернуть, по умолчанию 20"),
      },
    },
    async (input) => {
      // Данные берутся из реестра: векторный поиск здесь ни при чём.
      // Границы считаются той же проверкой, что и в поиске: образец даты
      // пропускает несуществующие числа, и без неё в запрос ушёл бы NaN.
      const fromUnix = input.from === undefined ? undefined : dateToUnix(input.from, "начала");
      const toUnix = input.to === undefined ? undefined : dateToUnix(input.to, "конца") + 86399;
      const streams = await services.registry.listStreams({
        limit: input.limit ?? 20,
        ...(fromUnix === undefined ? {} : { fromUnix }),
        ...(toUnix === undefined ? {} : { toUnix }),
      });
      const ready = streams.filter((stream) => stream.status === "ready");

      const lines = ready.map((stream) => {
        const categories = stream.categories.map((chapter) => chapter.title).join(", ");
        const duration = formatClock(stream.durationSeconds);
        return `${stream.publishedAt.slice(0, 10)} · «${documentName(stream)}» · ${duration} · разделов: ${stream.sectionCount ?? 0}${categories === "" ? "" : ` · ${categories}`}`;
      });

      return {
        content: [
          { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "Разобранных трансляций пока нет." },
        ],
        structuredContent: {
          streams: ready.map((stream) => ({
            vodId: stream.vodId,
            title: documentName(stream),
            publishedAt: stream.publishedAt,
            durationSeconds: stream.durationSeconds,
            categories: stream.categories.map((chapter) => chapter.title),
            sectionCount: stream.sectionCount ?? 0,
          })),
        },
      };
    },
  );

  return server;
}

/** Обработчик `/mcp`. Состояния между вызовами нет, поэтому создаётся на запрос. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createMcpServer(env), { route: "/mcp" })(request, env, ctx);
}
